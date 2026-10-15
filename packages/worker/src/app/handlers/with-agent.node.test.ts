import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'
import { createWithAgentHandler } from './with-agent.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createAnonymousTestDb() {
	const empty = { results: [], meta: { changes: 0, last_row_id: 0 } }
	const createStatement = (query: string) => ({
		query,
		bind: () => createStatement(query),
		all: async () => empty,
		first: async () => null,
		run: async () => ({ meta: empty.meta }),
	})
	return {
		prepare: createStatement,
		batch: (statements: Array<{ query?: string }>) =>
			executePreparedD1Batch(statements),
		exec: async () => undefined,
	} as unknown as D1Database
}

async function renderWith(agent: string) {
	setAuthSessionSecret(testCookieSecret)
	const env = {
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
	const response = await createWithAgentHandler(env).handler({
		request: new Request(`https://example.com/with/${agent}`),
		params: { agent },
	} as never)
	return { status: response.status, html: await response.text() }
}

test('/with/:agent highlights the agent and its shortest connect path', async () => {
	const { status, html } = await renderWith('claude-code')
	expect(status).toBe(200)
	expect(html).toContain('<title>Kody for Claude Code | Kody</title>')
	expect(html).toContain(
		'rel="canonical" href="https://example.com/with/claude-code"',
	)
	expect(html).toContain('Kody for <em>Claude Code</em>')
	expect(html).toContain(
		'claude mcp add --transport http -s user kody https://kody.codes/mcp',
	)
	expect(html).toContain('href="/features/credentials"')
	expect(html).toContain('href="/with/cursor"')
	expect(html).not.toContain('href="/with/claude-code"')
	expect(html).not.toContain('\u2014')
	expect(html).toContain('Rather let Claude Code handle it?')
	expect(html).not.toContain('official Kody setup')
})

test('/with/:agent leads with the setup prompt and MCP URL for agents without an official path', async () => {
	const { status, html } = await renderWith('amp')
	expect(status).toBe(200)
	expect(html).toContain('<title>Kody for Amp | Kody</title>')
	expect(html).toContain('Kody for <em>Amp</em>')
	expect(html).toMatch(/Amp doesn(&rsquo;|\u2019)t have an official Kody setup/)
	expect(
		html.match(/aria-label="Copy setup prompt, copy setup prompt"/g),
	).toHaveLength(1)
	expect(html).toContain('<code>https://kody.codes/mcp</code>')
	expect(html).not.toContain('Rather let ')
	expect(html).toContain('href="/with/cursor"')
})

test('/with/:agent 404s for agents outside the catalog', async () => {
	const { status } = await renderWith('not-an-agent')
	expect(status).toBe(404)
})
