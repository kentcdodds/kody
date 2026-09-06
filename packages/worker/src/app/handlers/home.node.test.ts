import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createHomeHandler } from '#app/handlers/home.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { hasResolvedRequestFeatureFlags } from '#app/request-feature-flags-cache.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#worker/usage/code-runs-window.ts', () => ({
	loadPublicCodeRunsWindow: vi.fn(async () => null),
}))

vi.mock('#app/onboarding-data.ts', () => ({
	loadOnboardingData: vi.fn(async () => ({
		ok: true,
		loggedIn: true,
		username: 'home-user',
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
	loadPublicOnboardingData: vi.fn(() => ({
		ok: true,
		loggedIn: false,
		username: null,
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

test('authenticated home SSR prefetches flags while loading page data', async () => {
	setAuthSessionSecret(testCookieSecret)
	const email = 'home@example.com'
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
		username: 'home-user',
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

	const request = new Request('https://example.com/', {
		headers: { Cookie: cookie },
	})
	vi.mocked(loadOnboardingData).mockImplementation(async () => {
		expect(hasResolvedRequestFeatureFlags(request)).toBe(true)
		expect(counts.batchSizes).toEqual([2, 2])
		return {
			ok: true,
			loggedIn: true,
			username: 'home-user',
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
		}
	})
	vi.mocked(renderAppPage).mockImplementation(async (input) => {
		const loaded = await loadSessionInfo(input.request, input.env)
		return Response.json({ session: loaded.session })
	})

	const response = await createHomeHandler(env).handler(
		new RequestContext(request),
	)
	expect(response.status).toBe(200)
	const body = (await response.json()) as {
		session: { username: string; featureFlags: Record<string, boolean> }
	}
	expect(body.session.username).toBe('home-user')
	expect(body.session.featureFlags).toEqual({
		'demo-indicator': true,
		'compact-mcp-server-instructions': true,
		'compute-overage-charging': true,
	})
	expect(counts.batchSizes).toEqual([2, 2])
})
