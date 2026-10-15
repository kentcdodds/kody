import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
import { loadHomePageOnboardingData } from '#app/onboarding-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { landingHeroPrimaryCta } from '#universal/landing-home-copy.ts'
import { withAgents } from '#universal/with-agents.ts'
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
	invalidateCommunityPublicCache()
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
			landingAgentOrder: ['muse', 'codex', 'cursor'],
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

test('homepage hero uses locked copy, compare, and one connect CTA', async () => {
	const anonymous = await renderHome('https://example.com/')
	expect(anonymous.status).toBe(200)
	expect(
		missing(anonymous.hero, [
			'The <em>shared cloud</em> for your team\u2019s agents',
			'One place for the credentials, tools, and workflows for every agent your team members use.',
			'Keep your agent. Kody is what it plugs into.',
			landingHeroPrimaryCta,
		]),
	).toEqual([])
	expect(landingHeroPrimaryCta).toBe('Connect your agent')
	// Without JavaScript the copy button cannot work, so the CTA also ships
	// as a plain link to the connect docs.
	expect(anonymous.hero).toContain(
		'href="/docs/connect-your-agent" class="landing-connect-fallback',
	)
	// The connect button is label-only; the agent marks live in the marquee.
	expect(anonymous.hero).not.toContain('/images/icons/claudecode.svg" alt=""')
	expect(anonymous.hero).toContain('aria-label="Agents that work with Kody"')
	for (const agent of withAgents) {
		expect(anonymous.hero).toContain(`href="/with/${agent.slug}"`)
	}
	const marquee =
		anonymous.hero.match(
			/<nav[^>]*class="landing-agents"[\s\S]*?<\/nav>/,
		)?.[0] ?? ''
	const marqueeOrder = [...marquee.matchAll(/href="\/with\/([^"]+)"/g)].map(
		(match) => match[1],
	)
	// SSR order comes from loader data; the second copy is the loop.
	expect(marqueeOrder.slice(0, 3)).toEqual(['muse', 'codex', 'cursor'])
	expect(marqueeOrder).toHaveLength(withAgents.length * 2)
	expect(marquee.match(/tabindex="-1"/g)).toHaveLength(withAgents.length)
	expect(anonymous.hero).not.toContain('/signup')
	expect(anonymous.hero).not.toContain('landing-hero-video')
	expect(anonymous.hero).not.toContain('landing-hero-agents')
	// Onboarding happens with the agent, so the homepage never links to it.
	expect(anonymous.html).not.toContain('href="/onboarding')
	expect(anonymous.html).not.toContain('\u2014')
	const [firstThumb, secondThumb] = homepageHeroVideos.map(
		(video) => `/youtube-thumb/${video.videoId}`,
	)
	expect(
		missing(anonymous.html, [
			'class="landing-pcard"',
			'href="/docs"',
			'landing-proof',
			'landing-hero-agents',
			'landing-videos',
			'role="listbox"',
			firstThumb!,
			'landing-hero-agent-light',
			'landing-hero-agent-track',
		]),
	).toEqual([])
	expect(anonymous.html.indexOf(firstThumb!)).toBeLessThan(
		anonymous.html.indexOf(secondThumb!),
	)
	expect(anonymous.html).not.toContain('data-embed-playlist')
	expect(anonymous.html).not.toContain('id="primitives"')

	const isSection =
		anonymous.html.match(
			/<section[^>]*class="landing-vs"[\s\S]*?<\/section>/,
		)?.[0] ?? ''
	expect(
		missing(isSection, [
			'What Kody <em>is</em> and <em>is not</em>',
			'Not an agent.',
			'Not a chat app.',
			'Not tied to one agent.',
			'The shared credentials, tools, and workflows behind every agent your team uses.',
		]),
	).toEqual([])

	const closing =
		anonymous.html.match(
			/<section[^>]*id="invisible-software"[\s\S]*?<\/section>/,
		)?.[0] ?? ''
	expect(
		missing(closing, [
			'Invisible <em>software</em>',
			'People want problems solved, not another app.',
			'href="/believe"',
			landingHeroPrimaryCta,
		]),
	).toEqual([])

	const signedIn = await renderHome('https://example.com/', true)
	expect(signedIn.status).toBe(200)
	expect(missing(signedIn.hero, [landingHeroPrimaryCta])).toEqual([])
	expect(signedIn.html).not.toContain('href="/onboarding')
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
