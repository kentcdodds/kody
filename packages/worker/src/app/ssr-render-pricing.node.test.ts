import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
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

test('renderAppPage renders the redesigned pricing page', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = {
		COOKIE_SECRET: testCookieSecret,
		SECRET_STORE_KEY: 'LOCAL_TEST_SECRET_STORE_KEY_32_CHARS_MINIMUM',
		...testOidcSigningEnv,
		APP_DB: createAnonymousTestDb(),
		BUNDLE_ARTIFACTS_KV: {},
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		MCP_CLIENT_HUB: {},
	} as unknown as Env

	const response = await renderAppPage({
		request: new Request('https://example.com/pricing'),
		env,
	})

	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).not.toContain('Standard')
	expect(html).not.toMatch(/\bMax\b/)
	expect(html).not.toContain('High stock')
	expect(html).not.toContain('concurrency ceilings')
	expect(html).toContain('Pro')
	expect(html).toContain('$12')
	expect(html).toContain(
		'More room for jobs, workflows, and daily volume. Add prepaid credits to lift rate caps.',
	)
	expect(html).toContain('Prepaid credits')
	expect(html).toContain('$0.004 per unique worker day')
	expect(html).toContain('Teams / Enterprise')
	expect(html).toContain('mailto:kody@kody.codes')
	expect(html).toContain('Unique worker days per month')
	expect(html).toContain('Durable Object rows read per month')
	expect(html).toContain('Execute calls per week')
	expect(html).toContain('Outbound fetches per week')
	expect(html).toContain('1,200')
	expect(html).toContain('Automation invocations per day')
	expect(html).toContain('1,000')
	expect(html).toContain('10,000')
	expect(html).toContain('15,000')
	expect(html).toContain('40,000')
	expect(html).not.toContain('120,000')
	expect(html).toMatch(/<a[^>]*href="\/docs\/kody-factory"[^>]*>factory<\/a>/)
})
