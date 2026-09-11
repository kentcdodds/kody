import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { createDiscordHandler } from '#app/handlers/discord.ts'
import { createFaqHandler } from '#app/handlers/faq.ts'
import { createSupportHandler } from '#app/handlers/support.ts'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
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

test('renderAppPage renders the public FAQ page for anonymous visitors', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv()

	const response = await createFaqHandler(env).handler({
		request: new Request('https://example.com/faq'),
	} as never)

	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).toContain('<title>FAQ</title>')
	expect(html).toContain('data-faq="replace-agents"')
	expect(html).toContain('data-faq="shared-account"')
	expect(html).toContain('mailto:support@kody.codes')
	expect(html).toContain('<details')
	expect(html).toContain('<summary>')
	expect(html).toContain('href="/faq">FAQ</a>')
	expect(html).toContain('data-faq="get-started"')
	expect(html).toContain('Create a free account from')
	expect(html).toContain('href="/signup"')
})

test('renderAppPage renders the public support page for anonymous visitors', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv()

	const response = await createSupportHandler(env).handler({
		request: new Request('https://example.com/support'),
	} as never)

	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).toContain('<title>Support</title>')
	expect(html).toContain('mailto:support@kody.codes')
	expect(html).toContain('support@kody.codes')
	expect(html).toContain('href="/support">Support</a>')
})

test('renderAppPage renders the public Discord connect page', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = {
		...createTestEnv(),
		DISCORD_CLIENT_ID: 'discord-client-id-test',
		DISCORD_CLIENT_SECRET: 'discord-client-secret-test',
	} as Env

	const response = await createDiscordHandler(env).handler({
		request: new Request('https://example.com/discord'),
	} as never)

	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).toContain('Connect Discord')
	expect(html).toContain('<title>Discord</title>')
	const heading = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/)?.[0]
	expect(heading).toContain('Discord')
	const connectButtons = (
		html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []
	).filter((button) => button.includes('Connect Discord'))
	expect(connectButtons).toHaveLength(1)
})
