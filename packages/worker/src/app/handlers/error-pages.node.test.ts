import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import {
	createInternalErrorPageHandler,
	createNotFoundPageHandler,
} from '#app/handlers/error-pages.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createAnonymousTestDb() {
	function createStatement(query: string) {
		const executeAll = async () => ({
			results: [],
			meta: { changes: 0, last_row_id: 0 },
		})
		return {
			query,
			bind() {
				return createStatement(query)
			},
			async all() {
				return executeAll()
			},
			async first() {
				return null
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

function readAppRootProps(html: string) {
	const match = html.match(
		/<script type="application\/json" id="rmx-data">([\s\S]*?)<\/script>/,
	)
	if (!match?.[1]) {
		throw new Error('rmx-data script not found in HTML response')
	}
	const rmxData = JSON.parse(match[1]) as {
		h: Record<string, { props: Record<string, unknown> }>
	}
	const entry = Object.values(rmxData.h)[0]
	if (!entry) {
		throw new Error('AppRoot hydration entry not found in rmx-data')
	}
	return entry.props
}

test('GET /404 and /500 are explicit illustrated error routes', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv()

	const notFoundResponse = await createNotFoundPageHandler(env).handler({
		request: new Request('https://example.com/404'),
	} as never)
	expect(notFoundResponse.status).toBe(404)
	const notFoundHtml = await notFoundResponse.text()
	expect(notFoundHtml).toContain('<title>Not found</title>')
	expect(notFoundHtml).toContain("This doesn't quite connect.")
	expect(notFoundHtml).toContain('src="/images/kody-404-disappointed.png"')
	expect(notFoundHtml).toContain('data-testid="not-found-page"')
	expect(readAppRootProps(notFoundHtml).notFound).toBe(true)

	const internalErrorResponse = await createInternalErrorPageHandler(
		env,
	).handler({
		request: new Request('https://example.com/500'),
	} as never)
	expect(internalErrorResponse.status).toBe(500)
	const internalErrorHtml = await internalErrorResponse.text()
	expect(internalErrorHtml).toContain('<title>Something went wrong</title>')
	expect(internalErrorHtml).toContain('We got a little zapped.')
	expect(internalErrorHtml).toContain('src="/images/kody-500-zapped.png"')
	expect(internalErrorHtml).toContain('data-testid="internal-error-page"')
	expect(readAppRootProps(internalErrorHtml).internalError).toBe(true)
})
