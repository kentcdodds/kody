import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'
import {
	computeOverageRatesUsd,
	formatDurableObjectRowsRead,
	planLimits,
} from '#universal/plans.ts'

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
	expect(html).toContain('Standard')
	expect(html).toContain('Pro')
	const count = new Intl.NumberFormat('en-US')
	expect(html).toContain(count.format(planLimits.free.maxRepos))
	expect(html).toContain(count.format(planLimits.standard.maxRepos))
	expect(html).toContain(count.format(planLimits.pro.maxRepos))
	expect(html).toContain(count.format(planLimits.free.maxExecuteCallsPerDay))
	expect(html).toContain(
		count.format(planLimits.standard.maxExecuteCallsPerDay),
	)
	expect(html).toContain(count.format(planLimits.pro.maxExecuteCallsPerDay))
	// Public Free/Standard share a 15-minute floor; public Pro is 5 minutes.
	expect(html).toContain('15 minutes')
	expect(html).toContain('5 minutes')
	expect(html).toContain('Unique worker days per month')
	expect(html).toContain('Durable Object rows read per month')
	expect(html).toContain(
		count.format(planLimits.free.maxUniqueWorkerDaysPerMonth),
	)
	expect(html).toContain(
		count.format(planLimits.standard.maxUniqueWorkerDaysPerMonth),
	)
	expect(html).toContain(
		count.format(planLimits.pro.maxUniqueWorkerDaysPerMonth),
	)
	expect(html).toContain(
		formatDurableObjectRowsRead(
			planLimits.free.maxDurableObjectRowsReadPerMonth,
		),
	)
	expect(html).toContain(
		formatDurableObjectRowsRead(
			planLimits.standard.maxDurableObjectRowsReadPerMonth,
		),
	)
	expect(html).toContain(
		formatDurableObjectRowsRead(
			planLimits.pro.maxDurableObjectRowsReadPerMonth,
		),
	)
	expect(html).toContain(`$${computeOverageRatesUsd.uniqueWorkerDay}`)
	expect(html).toContain('overages are not currently charged')
})
