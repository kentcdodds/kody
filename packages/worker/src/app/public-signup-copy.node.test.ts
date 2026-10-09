import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
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

function createTestEnv() {
	const empty = { results: [], meta: { changes: 0, last_row_id: 0 } }
	const createStatement = (query: string) => ({
		query,
		bind: () => createStatement(query),
		all: async () => empty,
		first: async () => null,
		run: async () => ({ meta: empty.meta }),
	})
	return {
		COOKIE_SECRET: testCookieSecret,
		SECRET_STORE_KEY: 'LOCAL_TEST_SECRET_STORE_KEY_32_CHARS_MINIMUM',
		...testOidcSigningEnv,
		APP_DB: {
			prepare: createStatement,
			batch: (statements: Array<{ query?: string }>) =>
				executePreparedD1Batch(statements),
			exec: async () => undefined,
		},
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
	].map(([, href, label = '']) => ({
		href,
		label: label.replace(/<[^>]+>/g, '').trim(),
	}))
}

async function renderMarketing(path: string) {
	invalidateCommunityPublicCache()
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

const signupLink = expect.arrayContaining([
	expect.objectContaining({ href: '/signup' }),
])

test('FAQ, pricing, and home SSR copy send visitors to create an account under anonymous cache rules', async () => {
	const faqResponse = await renderMarketing('/faq')
	expect(faqResponse.headers.get('Cache-Control')).toBe(
		anonymousHtmlCacheControl,
	)
	expect(faqResponse.headers.get('Vary')).toBe('Cookie')
	expect(anchors(faqGetStarted(await faqResponse.text()))).toEqual(signupLink)

	const pricingResponse = await renderMarketing('/pricing')
	expect(pricingResponse.headers.get('Cache-Control')).toBe(
		anonymousHtmlCacheControl,
	)
	const pricing = await pricingResponse.text()
	expect(pricing).not.toContain('id="plan-standard"')
	for (const planId of ['plan-free', 'plan-pro']) {
		expect(anchors(namedSection(pricing, planId))).toEqual(signupLink)
	}

	const home = await (await renderMarketing('/')).text()
	expect(home).toContain(homepageSignupPath.replaceAll('&', '&amp;'))
})

test('blog post closer invites visitors to create an account', async () => {
	invalidateCommunityPublicCache()
	setAuthSessionSecret(testCookieSecret)
	const slug = listBlogPosts()[0]?.slug
	if (!slug) throw new Error('expected a catalog blog post')
	const response = await createBlogPostHandler(createTestEnv()).handler({
		request: new Request(`https://example.com/blog/${slug}`),
		params: { slug },
	} as never)
	const cta = (await response.text()).match(
		/<div[^>]*>[\s\S]*Give your assistant a home[\s\S]*?<\/div>/,
	)?.[0]
	expect(anchors(cta ?? '')).toEqual(signupLink)
})
