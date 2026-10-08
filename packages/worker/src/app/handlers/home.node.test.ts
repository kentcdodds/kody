import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createHomeHandler } from '#app/handlers/home.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import type * as OnboardingData from '#app/onboarding-data.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#app/onboarding-data.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof OnboardingData>()
	return {
		...actual,
		loadOnboardingData: vi.fn(actual.loadOnboardingData),
	}
})

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
	// Rows the flag prefetch resolves: one global flag on, one user override on.
	const rowsFor = (query: string) => {
		const q = query.replace(/\s+/g, ' ').trim().toLowerCase()
		if (q.startsWith('select') && q.includes('from "users"')) return [userRow]
		if (q.includes('from user_roles ur')) {
			return [
				{ role_name: 'user', action: 'read', entity: 'user', access: 'own' },
			]
		}
		if (q.includes('from feature_flags') && !q.includes('where')) {
			return [{ key: 'demo-indicator', enabled: 1, rollout_percent: null }]
		}
		if (
			q.includes('from feature_flag_user_overrides') &&
			q.includes('where user_id = ?')
		) {
			return [{ flag_key: 'execute-invoke', enabled: 1 }]
		}
		return []
	}
	const env = {
		COOKIE_SECRET: testCookieSecret,
		FLAG_EXPOSURES: { writeDataPoint() {} },
		APP_DB: {
			prepare(query: string) {
				counts.prepare += 1
				const statement = {
					query,
					bind: () => statement,
					all: async () => ({ results: rowsFor(query), meta: { changes: 0 } }),
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
			exec: async () => undefined,
		} as unknown as D1Database,
	} as Env

	const request = new Request('https://example.com/', {
		headers: { Cookie: cookie },
	})
	vi.mocked(renderAppPage).mockImplementation(async (input) => {
		const loaded = await loadSessionInfo(input.request, input.env)
		return Response.json({ session: loaded.session })
	})

	silenceExpectedConsoleWarns(['landing-hero-videos'])
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockRejectedValue(new Error('offline'))
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
		'package-share-grants': false,
		'jev-search-rerank': false,
		'execute-invoke': true,
		'connection-profiles': false,
		'mcp-skills-extension': false,
	})
	expect(counts.batchSizes).toEqual([2, 3])
	expect(loadOnboardingData).not.toHaveBeenCalled()
	const homeInput = vi.mocked(renderAppPage).mock.calls.at(-1)?.[0]
	expect(homeInput?.loaderData?.onboarding).toMatchObject({
		loggedIn: true,
		username: 'home-user',
		emailVerified: false,
		featuredMcpServers: [],
		setupPrompt: '',
		persistPrompt: '',
	})
	expect(
		homeInput?.loaderData?.onboarding?.discoveryPrompt.length,
	).toBeGreaterThan(0)
	fetchMock.mockRestore()
})

test('anonymous home SSR omits the unused onboarding chooser catalog', async () => {
	vi.mocked(renderAppPage).mockResolvedValue(new Response('ok'))
	silenceExpectedConsoleWarns(['landing-hero-videos'])
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockRejectedValue(new Error('offline'))

	setAuthSessionSecret(testCookieSecret)
	const response = await createHomeHandler({
		COOKIE_SECRET: testCookieSecret,
	} as Env).handler(new RequestContext(new Request('https://example.com/')))
	expect(response.status).toBe(200)
	const input = vi.mocked(renderAppPage).mock.calls.at(-1)?.[0]
	expect(input?.loaderData?.onboarding?.discoveryPrompt.length).toBeGreaterThan(
		0,
	)
	expect(input?.loaderData?.landingHeroVideos).toEqual([])
	fetchMock.mockRestore()
})
