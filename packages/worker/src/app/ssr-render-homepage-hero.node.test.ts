import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { loadHomePageOnboardingData } from '#app/onboarding-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { landingHeroDemoPlaylistId } from '#universal/landing-hero-copy.ts'
import {
	landingCompareWithTitle,
	landingCompareWithoutTitle,
	landingHeroHeadlineEmphasis,
	landingHeroHeadlineLead,
	landingHeroLead,
	landingHeroPrimaryCta,
	landingHeroSecondaryCta,
	landingHeroSubheadEmphasis,
	landingHeroSubheadLead,
	landingHeroSubheadTail,
	landingHomePrimitives,
	landingVsHeading,
} from '#universal/landing-home-copy.ts'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'

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

function landingHeroMarkup(html: string) {
	const match = html.match(
		/<section[^>]*class="landing-hero"[\s\S]*?<\/section>/,
	)
	return match?.[0] ?? ''
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
] as const

function homepageOnboardingFixture(
	env: Env,
	requestUrl: string,
	loggedIn: boolean,
) {
	return loadHomePageOnboardingData({
		env,
		requestUrl,
		user: loggedIn ? { username: 'home-user', emailVerified: true } : null,
	})
}

test('homepage hero uses locked copy, compare, and session-aware connect CTA', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv()
	const requestUrl = 'https://example.com/'

	const anonymous = await renderAppPage({
		request: new Request(requestUrl),
		env,
		loaderData: {
			onboarding: homepageOnboardingFixture(env, requestUrl, false),
			landingHeroVideos: [...homepageHeroVideos],
		},
	})
	expect(anonymous.status).toBe(200)
	const anonymousHtml = await anonymous.text()
	const anonymousHero = landingHeroMarkup(anonymousHtml)
	expect(anonymousHero).toContain(landingHeroHeadlineLead)
	expect(anonymousHero).toContain(`<em>${landingHeroHeadlineEmphasis}</em>`)
	expect(anonymousHero).toContain(landingHeroSubheadLead)
	expect(anonymousHero).toContain(`<em>${landingHeroSubheadEmphasis}</em>`)
	expect(anonymousHero).toContain(landingHeroSubheadTail)
	expect(anonymousHero).toContain(landingHeroLead)
	expect(anonymousHero).toContain(landingHeroPrimaryCta)
	expect(anonymousHero).toContain(landingHeroSecondaryCta)
	expect(anonymousHero).toContain('href="#primitives"')
	expect(anonymousHero).toContain('/signup?utm_source=kody.codes')
	expect(anonymousHero).toContain(landingCompareWithoutTitle)
	expect(anonymousHero).toContain(landingCompareWithTitle)
	expect(anonymousHero).not.toContain('landing-hero-video')
	expect(anonymousHero).not.toContain('landing-hero-agents')
	expect(anonymousHtml).toContain('id="primitives"')
	expect(anonymousHtml).toContain(landingVsHeading)
	expect(anonymousHtml).toContain('href="/docs"')
	expect(anonymousHtml).toContain(landingHomePrimitives[0]!.body)
	expect(anonymousHtml).toContain('landing-proof')
	expect(anonymousHtml).toContain('landing-hero-agents')
	expect(anonymousHtml).toContain('landing-videos')
	expect(anonymousHtml).toContain('role="listbox"')
	expect(anonymousHtml).not.toContain(
		`/youtube-thumb/${homepageHeroVideos[0].videoId}`,
	)
	expect(anonymousHtml).toContain(
		`/youtube-thumb/${homepageHeroVideos[1].videoId}`,
	)
	expect(anonymousHtml).toContain(
		`data-embed-playlist="${landingHeroDemoPlaylistId}"`,
	)
	expect(anonymousHtml.indexOf('landing-hero')).toBeLessThan(
		anonymousHtml.indexOf('id="primitives"'),
	)
	expect(anonymousHtml.indexOf('id="primitives"')).toBeLessThan(
		anonymousHtml.indexOf('landing-vs'),
	)
	expect(anonymousHtml.indexOf('landing-vs')).toBeLessThan(
		anonymousHtml.indexOf('id="durable-software"'),
	)
	expect(anonymousHtml.indexOf('id="durable-software"')).toBeLessThan(
		anonymousHtml.indexOf('landing-proof'),
	)
	expect(anonymousHtml.indexOf('landing-proof')).toBeLessThan(
		anonymousHtml.indexOf('landing-testimonials'),
	)
	expect(anonymousHtml.indexOf('landing-testimonials')).toBeLessThan(
		anonymousHtml.indexOf('landing-ecosystem'),
	)
	expect(anonymousHtml.indexOf('landing-ecosystem')).toBeLessThan(
		anonymousHtml.indexOf('landing-videos'),
	)
	expect(anonymousHtml.indexOf('landing-videos')).toBeLessThan(
		anonymousHtml.indexOf('id="invite"'),
	)
	expect(anonymousHtml).toContain('landing-hero-agent-light')
	expect(anonymousHtml).toContain('landing-hero-agent-track')
	expect(anonymousHtml).not.toContain('landing-hero-agent-line')
	expect(anonymousHtml).not.toContain('landing-hero-agent-glow')
	expect(anonymousHtml).toContain('Watch Some ')
	expect(anonymousHtml).toContain('<em>Demos</em>')
	expect(anonymousHtml).toContain('Give your services a ')
	expect(anonymousHtml).toContain(
		'Create a free account and connect a service you already use.',
	)
	expect(anonymousHtml).toContain('aria-label="Services that work with Kody"')
	expect(anonymousHtml).toContain('href="/docs/github"')
	expect(anonymousHtml).toContain('href="/docs/slack"')

	const signedIn = await renderAppPage({
		request: new Request(requestUrl),
		env,
		loaderData: {
			onboarding: homepageOnboardingFixture(env, requestUrl, true),
			landingHeroVideos: [...homepageHeroVideos],
		},
	})
	expect(signedIn.status).toBe(200)
	const signedInHtml = await signedIn.text()
	const signedInHero = landingHeroMarkup(signedInHtml)
	expect(signedInHero).toContain(landingHeroPrimaryCta)
	expect(signedInHero).toContain('href="/onboarding"')
	expect(signedInHero).not.toContain('/signup?utm_source=kody.codes')
	expect(signedInHero).toContain(landingHeroSecondaryCta)
	expect(signedInHtml).toContain('landing-videos')
	expect(signedInHtml).toContain('landing-hero-agents')
	expect(signedInHtml).toContain(
		'You\u2019re in. Connect a service you already use and start saving packages.',
	)
})
