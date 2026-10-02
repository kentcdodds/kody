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
		connectedAgents: [],
		secondAgentStandardGift: {
			received: false,
			active: false,
			status: 'none',
			expiresAt: null,
			grantedAt: null,
		},
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

type Rows = Array<Record<string, unknown>>

function createAccountEnv(
	rows: {
		users?: Rows
		roles?: Rows
		flags?: Rows
		overrides?: Rows
	} = {},
) {
	const counts = { prepare: 0, batch: 0, batchSizes: [] as Array<number> }
	const resultsFor = (normalizedQuery: string) => {
		if (
			normalizedQuery.startsWith('select') &&
			normalizedQuery.includes('from "users"')
		) {
			return rows.users
		}
		if (normalizedQuery.includes('from user_roles ur')) return rows.roles
		if (
			normalizedQuery.includes('from feature_flags') &&
			!normalizedQuery.includes('where')
		) {
			return rows.flags
		}
		if (
			normalizedQuery.includes('from feature_flag_user_overrides') &&
			normalizedQuery.includes('where user_id = ?')
		) {
			return rows.overrides
		}
		return undefined
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
					bind: () => statement,
					all: async () => ({
						results: resultsFor(normalizedQuery) ?? [],
						meta: { changes: 0 },
					}),
					first: async () => null,
					run: async () => ({ meta: { changes: 0 } }),
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
	return { env, counts }
}

async function getAccount(env: Env, session: AuthSession) {
	setAuthSessionSecret(testCookieSecret)
	const cookie = await createAuthCookie(session, false)
	return createAccountHandler(env).handler(
		new RequestContext(
			new Request('https://example.com/account', {
				headers: { Cookie: cookie },
			}),
		),
	)
}

test('account handler redirects to login with a session-destroy cookie for stale or deleting accounts', async () => {
	const deletingUserId = 'a'.repeat(64)
	const cases = [
		{
			label: 'stale session',
			stableUserId: 'f'.repeat(64),
			email: 'missing@example.com',
			users: [],
		},
		{
			label: 'deleting account',
			stableUserId: deletingUserId,
			email: 'deleting@example.com',
			users: [
				{
					id: 7,
					email: 'deleting@example.com',
					username: 'deleting-user',
					stable_user_id: deletingUserId,
					deleting_at: '2026-08-31 15:00:00',
				},
			],
		},
	]
	for (const { label, stableUserId, email, users } of cases) {
		const { env } = createAccountEnv({ users })
		const response = await getAccount(env, {
			stableUserId,
			email,
			rememberMe: false,
		})
		const setCookie = response.headers.get('Set-Cookie') ?? ''
		expect({
			label,
			status: response.status,
			location: response.headers.get('Location'),
			clearsSession:
				setCookie.includes('kody_session=') && setCookie.includes('Max-Age=0'),
		}).toEqual({
			label,
			status: 302,
			location: 'https://example.com/login?redirectTo=%2Faccount',
			clearsSession: true,
		})
	}
})

test('authenticated account SSR batches user/role and flag reads into two round trips', async () => {
	const email = 'account@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	const { env, counts } = createAccountEnv({
		users: [
			{ id: 7, email, username: 'account-user', stable_user_id: stableUserId },
		],
		roles: [
			{ role_name: 'user', action: 'read', entity: 'user', access: 'own' },
		],
		flags: [{ key: 'demo-indicator', enabled: 1, rollout_percent: null }],
		overrides: [{ flag_key: 'execute-invoke', enabled: 1 }],
	})

	vi.mocked(renderAppPage).mockImplementation(async (input) => {
		const loaded = await loadSessionInfo(input.request, input.env)
		return Response.json({
			session: loaded.session,
			loaderData: input.loaderData,
		})
	})

	const response = await getAccount(env, {
		stableUserId,
		email,
		rememberMe: false,
	})
	expect(response.status).toBe(200)
	const body = (await response.json()) as {
		session: {
			username: string
			roles: Array<string>
			permissions: Array<string>
			featureFlags: Record<string, boolean>
		}
		loaderData: Record<string, unknown>
	}
	expect(body.session.username).toBe('account-user')
	expect(body.session.roles).toEqual(['user'])
	expect(body.session.permissions).toEqual(['read:user:own'])
	expect(body.session.featureFlags).toEqual({
		'demo-indicator': true,
		'package-share-grants': false,
		'secret-providers': false,
		'jev-search-rerank': false,
		'execute-invoke': true,
	})
	expect(Object.keys(body.loaderData).sort()).toEqual([
		'accountConnections',
		'accountProfile',
		'onboarding',
	])
	// Session batches: users+roles, then flags+overrides+experiments_opt_in.
	expect(counts.batchSizes).toEqual([2, 3])
	expect(counts.prepare).toBe(5)
	expect(counts.batch).toBe(2)
})
