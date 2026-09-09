import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { loadHomePageOnboardingData } from '#app/onboarding-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createAnonymousTestDb() {
	function createStatement(query: string) {
		const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
		const executeAll = async () => {
			if (
				normalizedQuery.includes('from feature_flags') ||
				normalizedQuery.includes('from feature_flag_user_overrides')
			) {
				return {
					results: [],
					meta: { changes: 0, last_row_id: 0 },
				}
			}
			return {
				results: [],
				meta: { changes: 0, last_row_id: 0 },
			}
		}
		return {
			query,
			bind() {
				return createStatement(query)
			},
			async all() {
				return executeAll()
			},
			async first() {
				const result = await executeAll()
				return result.results[0] ?? null
			},
			async run() {
				return { meta: { changes: 0, last_row_id: 0 } }
			},
		}
	}

	return {
		prepare(query: string) {
			return createStatement(query)
		},
		async batch(statements: Array<{ query?: string }>) {
			return await executePreparedD1Batch(statements)
		},
		async exec() {
			return
		},
	} as unknown as D1Database
}

function createTestEnv() {
	return {
		COOKIE_SECRET: testCookieSecret,
		SECRET_STORE_KEY: 'LOCAL_TEST_SECRET_STORE_KEY_32_CHARS_MINIMUM',
		...testOidcSigningEnv,
		APP_DB: createAnonymousTestDb(),
		BUNDLE_ARTIFACTS_KV: createMemoryKv(),
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		MCP_CLIENT_HUB: {},
	} as unknown as Env
}

function landingHeroMarkup(html: string) {
	const match = html.match(
		/<section[^>]*class="landing-hero"[\s\S]*?<\/section>/,
	)
	return match?.[0] ?? ''
}

function homepageOnboardingFixture(
	env: Env,
	requestUrl: string,
	loggedIn: boolean,
) {
	return loadHomePageOnboardingData({
		env,
		requestUrl,
		user: loggedIn ? { username: 'home-user', emailVerified: true } : null,
	})
}

test('homepage hero headline and session-aware CTAs', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv()
	const requestUrl = 'https://example.com/'

	const anonymous = await renderAppPage({
		request: new Request(requestUrl),
		env,
		loaderData: {
			onboarding: homepageOnboardingFixture(env, requestUrl, false),
		},
	})
	expect(anonymous.status).toBe(200)
	const anonymousHero = landingHeroMarkup(await anonymous.text())
	expect(anonymousHero).toContain('landing-hero-actions')
	expect(anonymousHero).toContain('Create a free account')
	expect(anonymousHero).toContain('Copy the discovery prompt')

	const signedIn = await renderAppPage({
		request: new Request(requestUrl),
		env,
		loaderData: {
			onboarding: homepageOnboardingFixture(env, requestUrl, true),
		},
	})
	expect(signedIn.status).toBe(200)
	const signedInHero = landingHeroMarkup(await signedIn.text())
	expect(signedInHero).not.toContain('landing-hero-actions')
	expect(signedInHero).not.toContain('Create a free account')
	expect(signedInHero).not.toContain('Copy the discovery prompt')
})
