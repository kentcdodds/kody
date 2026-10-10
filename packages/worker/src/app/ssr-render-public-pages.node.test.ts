import { acquisitionPages } from '#universal/acquisition/catalog.ts'
import { createAcquisitionHandler } from '#app/handlers/acquisition.ts'
import { buildSitemapXml } from '#app/agent-discovery.ts'
import { clientRouteAreaNameForPath } from '#client/lazy-route.tsx'
import { getGuideBySlug } from '#worker/guides/catalog.ts'
import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
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
	invalidateCommunityPublicCache()
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
	invalidateCommunityPublicCache()
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
	invalidateCommunityPublicCache()
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

test('acquisition pages render crawlable HTML, metadata, navigation, and matching markdown', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv()
	const sitemap = buildSitemapXml('https://example.com')
	for (const page of acquisitionPages) {
		const request = new Request(`https://example.com${page.path}`)
		const response = await createAcquisitionHandler(env).handler({
			request,
		} as never)
		expect(response.status).toBe(200)
		expect(response.headers.get('vary')).toMatch(/accept/i)
		const html = await response.text()
		expect(html).toContain(`<h1>${page.title}</h1>`)
		expect(html).toContain(`content="${page.description}"`)
		expect(html).toContain(`href="https://example.com${page.path}"`)
		expect(html).toContain('href="/onboarding"')
		expect(html).toContain('Copy prompt')
		expect(html).toContain('id="try-it"')
		expect(html).toContain('aria-pressed="true"')
		expect(html).not.toMatch(/aria-pressed(?:\s|>)/)
		for (const [, slug] of html.matchAll(/href="\/docs\/([^"#?]+)[^"]*"/g)) {
			expect(getGuideBySlug(slug!), `${page.path}: /docs/${slug}`).toBeTruthy()
		}
		expect(sitemap).toContain(`<loc>https://example.com${page.path}</loc>`)
		expect(clientRouteAreaNameForPath(page.path)).toBe('marketing-area')
		for (const source of page.sources.filter((source) =>
			source.href.startsWith('/docs/'),
		)) {
			expect(
				getGuideBySlug(source.href.slice('/docs/'.length)),
				source.href,
			).toBeTruthy()
		}
		const markdown = await createAcquisitionHandler(env).handler({
			request: new Request(request.url, {
				headers: { Accept: 'text/markdown' },
			}),
		} as never)
		expect(markdown.headers.get('content-type')).toBe(
			'text/markdown; charset=utf-8',
		)
		const body = await markdown.text()
		expect(body).toContain(`# ${page.title}`)
		expect(body).toContain(page.prompt)
		for (const section of page.sections)
			expect(body).toContain(`## ${section.title}`)
	}
})

test('use-case index exposes every landing page in HTML and Markdown', async () => {
	const env = createTestEnv()
	const handler = createAcquisitionHandler(env)
	const response = await handler.handler({
		request: new Request('https://example.com/use-cases'),
	} as never)
	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).toContain('What will you build with Kody?')
	expect(html).toContain('href="https://example.com/use-cases"')
	const markdown = await handler.handler({
		request: new Request('https://example.com/use-cases', {
			headers: { Accept: 'text/markdown' },
		}),
	} as never)
	expect(markdown.status).toBe(200)
	const text = await markdown.text()
	for (const page of acquisitionPages) {
		expect(html).toContain(`href="${page.path}"`)
		expect(text).toContain(`](${page.path})`)
	}
	expect(clientRouteAreaNameForPath('/use-cases')).toBe('marketing-area')
})
