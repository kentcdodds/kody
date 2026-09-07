import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { createPrivacyHandler } from '#app/handlers/privacy.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const privacyDocPath = resolve(
	import.meta.dirname,
	'../../../../docs/use/privacy.md',
)

function flatten(text: string) {
	return text.replace(/\s+/g, ' ')
}

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

test('privacy page and usage doc distinguish chat-model inference from embeddings', async () => {
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

	const response = await createPrivacyHandler(env).handler({
		request: new Request('https://example.com/privacy'),
	} as never)

	expect(response.status).toBe(200)
	const html = flatten(await response.text())
	expect(html).toContain('<title>Privacy</title>')
	expect(html).toContain('does not run its own chat-model agent loop')
	expect(html).toContain('does not bill for chat tokens')
	expect(html).toContain('Cloudflare Workers AI')
	expect(html).toContain('embeddings')
	expect(html).toContain('manifest search fields, not full source')
	expect(html).toContain('memories (subject, summary, details, and tags)')
	expect(html).toContain('Secret values and OAuth tokens are never sent')
	expect(html).toContain(
		'Connected-account provider content is embedded only if it was first saved',
	)
	expect(html).toContain('Workers AI embeddings for search')
	expect(html).toContain('train a Kody model')
	expect(html).toContain('SECRET_STORE_KEY')
	expect(html).toContain(
		'Cloudflare (hosting, including Workers AI embeddings for content first saved as an indexed record)',
	)

	const privacyDoc = flatten(readFileSync(privacyDocPath, 'utf8'))
	expect(privacyDoc).toContain(
		'does not run its own chat-model agent loop and does not bill for chat tokens',
	)
	expect(privacyDoc).toContain(
		'Search and indexing do call Cloudflare Workers AI for embeddings',
	)
	expect(privacyDoc).toContain('manifest search fields, not full source')
	expect(privacyDoc).toContain(
		'Connected-account provider content is embedded only if it was first saved as one of those indexed records.',
	)
	expect(privacyDoc).toContain(
		'network infrastructure, and Workers AI embeddings for search',
	)
	expect(privacyDoc).toContain(
		'network, and Workers AI embeddings; the MCP host you connected',
	)
	expect(privacyDoc).toContain(
		'Cloudflare (hosting, including Workers AI embeddings for content first saved as an indexed record)',
	)
})
