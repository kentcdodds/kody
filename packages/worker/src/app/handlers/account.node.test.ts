import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountHandler } from '#app/handlers/account.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { loadSessionInfo } from '#app/session-info.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#app/account-profile-data.ts', () => ({
	loadAccountProfileData: vi.fn(async () => ({
		ok: true,
		email: 'account@example.com',
		emailVerified: false,
		username: 'account-user',
		displayName: 'account-user',
		bio: null,
		avatarUrl: null,
		profileVisibility: 'public',
		formerEmails: [],
	})),
}))

vi.mock('#app/account-connections-data.ts', () => ({
	loadAccountConnectionsData: vi.fn(async () => ({
		ok: true,
		connections: [],
		canDisconnect: false,
		hasUsablePassword: true,
		availableProviders: [],
		canSyncDiscordRoles: false,
	})),
}))

vi.mock('#app/onboarding-data.ts', () => ({
	loadOnboardingData: vi.fn(async () => ({
		ok: true,
		loggedIn: true,
		username: 'account-user',
		mcpServerUrl: 'https://example.com/mcp',
		setupPrompt: '',
		discoveryPrompt: '',
		persistPrompt: '',
		hasAccessWin: false,
		hasSecondMcpClient: false,
		hasMcpClient: false,
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		featuredMcpServers: [],
		customMcpServers: [],
		persistedPackageName: null,
		accessWinMemorySubject: null,
		checklist: null,
	})),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(),
}))

function createStaleSessionTestEnv() {
	return {
		COOKIE_SECRET: testCookieSecret,
		APP_DB: {
			prepare(query: string) {
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					query,
					bind() {
						return {
							query,
							async all() {
								if (
									normalizedQuery.startsWith('select') &&
									normalizedQuery.includes('from "users"')
								) {
									return { results: [], meta: { changes: 0 } }
								}
								if (normalizedQuery.includes('from user_roles ur')) {
									return { results: [], meta: { changes: 0 } }
								}
								return { results: [], meta: { changes: 0 } }
							},
							async first() {
								return null
							},
							async run() {
								return { meta: { changes: 0 } }
							},
						}
					},
				}
			},
			async batch(statements: Array<{ query?: string }>) {
				return await executePreparedD1Batch(statements)
			},
			async exec() {
				return
			},
		} as unknown as D1Database,
	} as Env
}

test('account handler redirects to login with a session-destroy cookie for stale sessions', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: 'f'.repeat(64),
		email: 'missing@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	const handler = createAccountHandler(createStaleSessionTestEnv())
	const response = await handler.handler(
		new RequestContext(
			new Request('https://example.com/account', {
				headers: { Cookie: cookie },
			}),
		),
	)

	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://example.com/login?redirectTo=%2Faccount',
	)
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('kody_session=')
	expect(setCookie).toContain('Max-Age=0')
})

test('account handler redirects to login and clears the cookie for a deleting account', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: 'a'.repeat(64),
		email: 'deleting@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	const env = {
		COOKIE_SECRET: testCookieSecret,
		APP_DB: {
			prepare(query: string) {
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					query,
					bind() {
						return {
							query,
							async all() {
								if (
									normalizedQuery.startsWith('select') &&
									normalizedQuery.includes('from "users"')
								) {
									return {
										results: [
											{
												id: 7,
												email: 'deleting@example.com',
												username: 'deleting-user',
												stable_user_id: 'a'.repeat(64),
												deleting_at: '2026-08-31 15:00:00',
											},
										],
										meta: { changes: 0 },
									}
								}
								if (normalizedQuery.includes('from user_roles ur')) {
									return { results: [], meta: { changes: 0 } }
								}
								return { results: [], meta: { changes: 0 } }
							},
							async first() {
								return null
							},
							async run() {
								return { meta: { changes: 0 } }
							},
						}
					},
				}
			},
			async batch(statements: Array<{ query?: string }>) {
				return await executePreparedD1Batch(statements)
			},
			async exec() {
				return
			},
		} as unknown as D1Database,
	} as Env
	const handler = createAccountHandler(env)
	const response = await handler.handler(
		new RequestContext(
			new Request('https://example.com/account', {
				headers: { Cookie: cookie },
			}),
		),
	)

	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://example.com/login?redirectTo=%2Faccount',
	)
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('kody_session=')
	expect(setCookie).toContain('Max-Age=0')
})

test('authenticated account SSR batches user/role and flag reads into two round trips', async () => {
	setAuthSessionSecret(testCookieSecret)
	const email = 'account@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	const session: AuthSession = {
		stableUserId,
		email,
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	const counts = { prepare: 0, batch: 0, batchSizes: [] as Array<number> }
	const userRow = {
		id: 7,
		email,
		username: 'account-user',
		stable_user_id: stableUserId,
	}
	const env = {
		COOKIE_SECRET: testCookieSecret,
		FLAG_EXPOSURES: { writeDataPoint() {} },
		APP_DB: {
			prepare(query: string) {
				counts.prepare += 1
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				const statement = {
					query,
					bind() {
						return statement
					},
					async all() {
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"')
						) {
							return { results: [userRow], meta: { changes: 0 } }
						}
						if (normalizedQuery.includes('from user_roles ur')) {
							return {
								results: [
									{
										role_name: 'user',
										action: 'read',
										entity: 'user',
										access: 'own',
									},
								],
								meta: { changes: 0 },
							}
						}
						if (
							normalizedQuery.includes('from feature_flags') &&
							!normalizedQuery.includes('where')
						) {
							return {
								results: [
									{
										key: 'demo-indicator',
										enabled: 1,
										rollout_percent: null,
									},
								],
								meta: { changes: 0 },
							}
						}
						if (
							normalizedQuery.includes('from feature_flag_user_overrides') &&
							normalizedQuery.includes('where user_id = ?')
						) {
							return {
								results: [
									{
										flag_key: 'compact-mcp-server-instructions',
										enabled: 1,
									},
								],
								meta: { changes: 0 },
							}
						}
						return { results: [], meta: { changes: 0 } }
					},
					async first() {
						return null
					},
					async run() {
						return { meta: { changes: 0 } }
					},
				}
				return statement
			},
			async batch(statements: Array<{ query?: string }>) {
				counts.batch += 1
				counts.batchSizes.push(statements.length)
				return await executePreparedD1Batch(statements)
			},
			async exec() {
				return
			},
		} as unknown as D1Database,
	} as Env

	vi.mocked(renderAppPage).mockImplementation(async (input) => {
		const loaded = await loadSessionInfo(input.request, input.env)
		return Response.json({
			session: loaded.session,
			loaderData: input.loaderData,
		})
	})

	const response = await createAccountHandler(env).handler(
		new RequestContext(
			new Request('https://example.com/account', {
				headers: { Cookie: cookie },
			}),
		),
	)
	expect(response.status).toBe(200)
	const body = (await response.json()) as {
		session: {
			username: string
			roles: Array<string>
			permissions: Array<string>
			featureFlags: Record<string, boolean>
		}
	}
	expect(body.session.username).toBe('account-user')
	expect(body.session.roles).toEqual(['user'])
	expect(body.session.permissions).toEqual(['read:user:own'])
	expect(body.session.featureFlags).toEqual({
		'demo-indicator': true,
		'compact-mcp-server-instructions': true,
	})
	// Before: 4 sequential prepares (users, roles, flags, overrides).
	// After: those same 4 prepares run as two 2-statement batches.
	expect(counts.batchSizes).toEqual([2, 2])
	expect(counts.prepare).toBe(4)
	expect(counts.batch).toBe(2)
})
