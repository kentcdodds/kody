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
import { type SignupMode } from '#universal/signup-mode.ts'

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

function createTestEnv(signupMode?: SignupMode) {
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
		...(signupMode ? { SIGNUP_MODE: signupMode } : {}),
	} as unknown as Env
}

function parseRmxData(html: string) {
	const match = html.match(
		/<script type="application\/json" id="rmx-data">([\s\S]*?)<\/script>/,
	)
	if (!match?.[1]) {
		throw new Error('rmx-data script not found in HTML response')
	}
	return JSON.parse(match[1]) as {
		h: Record<
			string,
			{
				props: {
					loaderData?: { signupMode?: SignupMode }
				}
			}
		>
	}
}

function readEmbeddedSignupMode(html: string) {
	const rmxData = parseRmxData(html)
	const entry = Object.values(rmxData.h)[0]
	return entry?.props.loaderData?.signupMode
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

async function renderMarketing(path: string, signupMode?: SignupMode) {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv(signupMode)
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
					signupMode: signupMode ?? 'invite',
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

test('FAQ, pricing, and home SSR copy follow invite, open, and waitlist destinations', async () => {
	const inviteFaq = await (await renderMarketing('/faq', 'invite')).text()
	const openFaq = await (await renderMarketing('/faq', 'open')).text()
	const waitlistFaq = await (await renderMarketing('/faq', 'waitlist')).text()

	expect(readEmbeddedSignupMode(inviteFaq)).toBe('invite')
	expect(readEmbeddedSignupMode(openFaq)).toBe('open')
	expect(readEmbeddedSignupMode(waitlistFaq)).toBe('waitlist')

	const inviteStarted = faqGetStarted(inviteFaq)
	expect(inviteStarted).toContain('Kody is invite-only')
	expect(anchors(inviteStarted)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ href: '/signup', label: 'Sign up' }),
			expect.objectContaining({ href: '/#invite', label: 'home page' }),
		]),
	)
	expect(inviteStarted).not.toContain('panel=waiting-list')
	expect(inviteStarted).not.toContain('panel=invite')

	const openStarted = faqGetStarted(openFaq)
	expect(openStarted).toContain('Create a free account from')
	expect(anchors(openStarted)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ href: '/signup', label: 'Sign up' }),
		]),
	)
	expect(openStarted).not.toContain('invite-only')
	expect(openStarted).not.toContain('/#invite')

	const waitlistStarted = faqGetStarted(waitlistFaq)
	expect(waitlistStarted).toContain('Join the waiting list from')
	expect(anchors(waitlistStarted)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				href: '/signup?panel=waiting-list',
				label: 'Sign up',
			}),
			expect.objectContaining({
				href: '/signup?panel=invite',
				label: 'redeem it',
			}),
		]),
	)
	expect(waitlistStarted).not.toContain('invite-only')

	const invitePricing = await (
		await renderMarketing('/pricing', 'invite')
	).text()
	const openPricing = await (await renderMarketing('/pricing', 'open')).text()
	const waitlistPricing = await (
		await renderMarketing('/pricing', 'waitlist')
	).text()

	for (const planId of ['plan-free', 'plan-standard', 'plan-pro'] as const) {
		expect(anchors(namedSection(invitePricing, planId))).toEqual(
			expect.arrayContaining([
				{ href: '/#invite', label: 'Join the waiting list' },
			]),
		)
		expect(anchors(namedSection(openPricing, planId))).toEqual(
			expect.arrayContaining([
				{ href: '/signup', label: 'Create a free account' },
			]),
		)
		expect(anchors(namedSection(waitlistPricing, planId))).toEqual(
			expect.arrayContaining([
				{ href: '/#invite', label: 'Join the waiting list' },
			]),
		)
	}

	const inviteHome = await (await renderMarketing('/', 'invite')).text()
	const openHome = await (await renderMarketing('/', 'open')).text()
	const waitlistHome = await (await renderMarketing('/', 'waitlist')).text()

	expect(inviteHome).toContain('href="#invite"')
	expect(inviteHome).toContain('Join the waiting list')
	expect(inviteHome).toContain(homepageSignupPath.replaceAll('&', '&amp;'))
	expect(inviteHome).toContain('I have a code')
	expect(inviteHome).toContain('Copy the discovery prompt')
	expect(inviteHome).not.toContain('>Create a free account<')

	expect(openHome).toContain(homepageSignupPath.replaceAll('&', '&amp;'))
	expect(openHome).toContain('Create a free account')
	expect(openHome).toContain('Copy the discovery prompt')
	expect(openHome).not.toContain('href="#invite"')
	expect(openHome).not.toContain('Join the waiting list')

	expect(waitlistHome).toContain('href="#invite"')
	expect(waitlistHome).toContain('Join the waiting list')
	expect(waitlistHome).toContain('I have a code')
	expect(waitlistHome).toContain('Copy the discovery prompt')
	expect(waitlistHome).not.toContain('>Create a free account<')
})

test('FAQ and pricing handlers keep anonymous cache rules while embedding signup mode', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv('open')

	const faq = await createFaqHandler(env).handler({
		request: new Request('https://example.com/faq'),
	} as never)
	const pricing = await createPricingHandler(env).handler({
		request: new Request('https://example.com/pricing'),
	} as never)

	expect(faq.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
	expect(faq.headers.get('Vary')).toBe('Cookie')
	expect(pricing.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
	expect(readEmbeddedSignupMode(await faq.text())).toBe('open')
	expect(readEmbeddedSignupMode(await pricing.text())).toBe('open')
})

test('blog post closer follows the resolved signup mode', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const slug = listBlogPosts()[0]?.slug
	expect(slug).toBeTruthy()
	if (!slug) throw new Error('expected a catalog blog post')

	const invite = await createBlogPostHandler(createTestEnv('invite')).handler({
		request: new Request(`https://example.com/blog/${slug}`),
		params: { slug },
	} as never)
	const open = await createBlogPostHandler(createTestEnv('open')).handler({
		request: new Request(`https://example.com/blog/${slug}`),
		params: { slug },
	} as never)

	const inviteHtml = await invite.text()
	const openHtml = await open.text()
	const inviteCta = inviteHtml.match(
		/<div[^>]*>[\s\S]*Give your assistant a home[\s\S]*?<\/div>/,
	)?.[0]
	const openCta = openHtml.match(
		/<div[^>]*>[\s\S]*Give your assistant a home[\s\S]*?<\/div>/,
	)?.[0]

	expect(inviteCta).toContain('Invite-only while we grow the eucalyptus')
	expect(anchors(inviteCta ?? '')).toEqual(
		expect.arrayContaining([
			{ href: '/#invite', label: 'Join the waiting list' },
		]),
	)
	expect(openCta).toContain('Create a free account and start saving packages')
	expect(anchors(openCta ?? '')).toEqual(
		expect.arrayContaining([
			{ href: '/signup', label: 'Create a free account' },
		]),
	)
	expect(openCta).not.toContain('Invite-only')
})
