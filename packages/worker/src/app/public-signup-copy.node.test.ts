import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { createBlogPostHandler } from '#app/handlers/blog.tsx'
import { createFaqHandler } from '#app/handlers/faq.ts'
import { createPricingHandler } from '#app/handlers/pricing.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { anonymousHtmlCacheControl } from '#app/anonymous-html-cache.ts'
import { listBlogPosts } from '#worker/blog/catalog.ts'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'
import { loadHomePageOnboardingData } from '#app/onboarding-data.ts'
import { homepageSignupPath } from '#universal/first-touch-attribution.ts'

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

function faqGetStarted(html: string) {
	return html.match(/data-faq="get-started"[\s\S]*?<\/details>/)?.[0] ?? ''
}

function namedSection(html: string, id: string) {
	return (
		html.match(
			new RegExp(`<section[^>]*aria-labelledby="${id}"[\\s\\S]*?</section>`),
		)?.[0] ?? ''
	)
}

function anchors(html: string) {
	return [
		...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g),
	].map(([, href, label]) => ({
		href,
		label: label.replace(/<[^>]+>/g, '').trim(),
	}))
}

async function renderMarketing(path: string) {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv()
	const request = new Request(`https://example.com${path}`)
	switch (path) {
		case '/faq':
			return createFaqHandler(env).handler({ request } as never)
		case '/pricing':
			return createPricingHandler(env).handler({ request } as never)
		case '/':
			return renderAppPage({
				request,
				env,
				loaderData: {
					onboarding: loadHomePageOnboardingData({
						env,
						requestUrl: request.url,
					}),
				},
			})
		default:
			throw new Error(`unsupported path ${path}`)
	}
}

test('FAQ, pricing, and home SSR copy send visitors to create an account', async () => {
	const faq = await (await renderMarketing('/faq')).text()
	const started = faqGetStarted(faq)
	expect(anchors(started)).toEqual(
		expect.arrayContaining([expect.objectContaining({ href: '/signup' })]),
	)

	const pricing = await (await renderMarketing('/pricing')).text()
	for (const planId of ['plan-free', 'plan-standard', 'plan-pro'] as const) {
		expect(anchors(namedSection(pricing, planId))).toEqual(
			expect.arrayContaining([expect.objectContaining({ href: '/signup' })]),
		)
	}

	const home = await (await renderMarketing('/')).text()
	expect(home).toContain(homepageSignupPath.replaceAll('&', '&amp;'))
})

test('FAQ and pricing handlers keep anonymous cache rules', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv()

	const faq = await createFaqHandler(env).handler({
		request: new Request('https://example.com/faq'),
	} as never)
	const pricing = await createPricingHandler(env).handler({
		request: new Request('https://example.com/pricing'),
	} as never)

	expect(faq.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
	expect(faq.headers.get('Vary')).toBe('Cookie')
	expect(pricing.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
})

test('blog post closer invites visitors to create an account', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const slug = listBlogPosts()[0]?.slug
	expect(slug).toBeTruthy()
	if (!slug) throw new Error('expected a catalog blog post')

	const response = await createBlogPostHandler(createTestEnv()).handler({
		request: new Request(`https://example.com/blog/${slug}`),
		params: { slug },
	} as never)

	const html = await response.text()
	const cta = html.match(
		/<div[^>]*>[\s\S]*Give your assistant a home[\s\S]*?<\/div>/,
	)?.[0]

	expect(anchors(cta ?? '')).toEqual(
		expect.arrayContaining([expect.objectContaining({ href: '/signup' })]),
	)
})
