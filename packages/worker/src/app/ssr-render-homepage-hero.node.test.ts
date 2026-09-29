import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { loadHomePageOnboardingData } from '#app/onboarding-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { landingFactoryBeats } from '#universal/landing-factory-beats.ts'
import { landingHeroPrimaryCta } from '#universal/landing-home-copy.ts'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'

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

const homepageHeroVideos = [
	{
		videoId: 'iGMkgjXc8Ho',
		title: 'Build in Cursor, then run it from Claude Code or ChatGPT',
	},
	{
		videoId: 'QA0xYMAMjEg',
		title: 'Introducing Kody: Your Personal Software Factory',
	},
	{
		videoId: 'o5L5OprLhBg',
		title: 'Kody fixes a Stripe webhook after we renamed the domain',
	},
	{
		videoId: 'OZKDO9Pzmo0',
		title: 'Shade automation from an INTENT.md',
	},
] as const

async function renderHome(requestUrl: string, loggedIn = false) {
	resetDataCacheForTests()
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
	const response = await renderAppPage({
		request: new Request(requestUrl),
		env,
		loaderData: {
			onboarding: loadHomePageOnboardingData({
				env,
				requestUrl,
				user: loggedIn ? { username: 'home-user', emailVerified: true } : null,
			}),
			landingHeroVideos: [...homepageHeroVideos],
		},
	})
	const html = await response.text()
	const hero =
		html.match(/<section[^>]*class="landing-hero"[\s\S]*?<\/section>/)?.[0] ??
		''
	return { status: response.status, html, hero }
}

function missing(html: string, markers: Array<string>) {
	return markers.filter((marker) => !html.includes(marker))
}

test('homepage hero uses locked copy, compare, and session-aware connect CTA', async () => {
	const anonymous = await renderHome('https://example.com/')
	expect(anonymous.status).toBe(200)
	expect(
		missing(anonymous.hero, [
			landingHeroPrimaryCta,
			'href="#primitives"',
			'/signup?utm_source=kody.codes',
		]),
	).toEqual([])
	expect(anonymous.hero).not.toContain('landing-hero-video')
	expect(anonymous.hero).not.toContain('landing-hero-agents')
	const [firstThumb, secondThumb] = homepageHeroVideos.map(
		(video) => `/youtube-thumb/${video.videoId}`,
	)
	expect(
		missing(anonymous.html, [
			'id="primitives"',
			'href="/docs"',
			'landing-proof',
			'landing-hero-agents',
			'landing-videos',
			'role="listbox"',
			firstThumb!,
			'landing-hero-agent-light',
			'landing-hero-agent-track',
			'href="/docs/github"',
			'href="/docs/slack"',
			'aria-label="Example triggers"',
			...landingFactoryBeats.flatMap((beat) => [
				`href="/docs/${beat.slug}"`,
				beat.trigger,
				beat.title,
			]),
		]),
	).toEqual([])
	expect(anonymous.html.indexOf(firstThumb!)).toBeLessThan(
		anonymous.html.indexOf(secondThumb!),
	)
	expect(anonymous.html).not.toContain('data-embed-playlist')
	const inviteTools =
		anonymous.html.match(
			/<ul[^>]*class="[^"]*landing-invite-tools[^"]*"[\s\S]*?<\/ul>/,
		)?.[0] ?? ''
	const toolIcons = ['github', 'linear', 'sentry', 'cloudflare', 'slack']
	expect(
		missing(inviteTools, [
			'GitHub',
			'Linear',
			'Sentry',
			'Cloudflare',
			'Slack',
			'Public packages',
			...toolIcons.map((icon) => `/images/icons/${icon}.svg`),
		]),
	).toEqual([])

	const signedIn = await renderHome('https://example.com/', true)
	expect(signedIn.status).toBe(200)
	expect(
		missing(signedIn.hero, [landingHeroPrimaryCta, 'href="/onboarding"']),
	).toEqual([])
	expect(signedIn.hero).not.toContain('/signup?utm_source=kody.codes')
	expect(
		missing(signedIn.html, ['landing-videos', 'landing-hero-agents']),
	).toEqual([])
})

test('homepage ?og= points crawlers at that card and keeps the canonical url clean', async () => {
	const variant = await renderHome(
		'https://example.com/?og=triggers&utm_source=youtube#primitives',
	)
	expect(variant.status).toBe(200)
	const imageUrl = 'https://example.com/og/home.png?og=triggers'
	expect(
		missing(variant.html, [
			`property="og:image" content="${imageUrl}"`,
			`name="twitter:image" content="${imageUrl}"`,
			'property="og:title" content="Invoke deterministic code from anything"',
			'rel="canonical" href="https://example.com/"',
		]),
	).toEqual([])
	expect(variant.html).not.toContain(
		'og:url" content="https://example.com/?og=',
	)

	const unknown = await renderHome('https://example.com/?og=nope')
	expect(unknown.html).toContain(
		'property="og:image" content="https://example.com/og/home.png"',
	)
	expect(unknown.html).not.toContain('/og/home.png?og=')
})
