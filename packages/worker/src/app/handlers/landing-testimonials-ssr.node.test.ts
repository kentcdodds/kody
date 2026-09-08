import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { createBlogPostHandler } from '#app/handlers/blog.tsx'
import { renderAppPage } from '#app/ssr-render.tsx'
import { getBlogPost, getReadNextBlogPost } from '#worker/blog/catalog.ts'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'
import {
	landingTestimonials,
	landingTestimonialsStorySlug,
} from '#universal/landing-testimonials.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createAnonymousTestDb() {
	function createStatement(query: string) {
		return {
			query,
			bind() {
				return createStatement(query)
			},
			async all() {
				return { results: [], meta: { changes: 0, last_row_id: 0 } }
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

test('homepage carousel SSR keeps short quotes and story links only for vignettes', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const response = await renderAppPage({
		request: new Request('https://example.com/'),
		env: createTestEnv(),
		loaderData: { signupMode: 'invite' },
	})
	expect(response.status).toBe(200)
	const html = await response.text()

	const josh = landingTestimonials.find(
		(entry) => entry.name === 'Josh Tomaino',
	)
	const jett = landingTestimonials.find((entry) => entry.name === 'Jett Hays')
	if (!josh || !jett) throw new Error('expected Josh and Jett testimonials')

	expect(html).toContain(josh.quote)
	expect(html).toContain(jett.quote)
	expect(html.match(/class="landing-testimonial-story"/g)).toHaveLength(2)
	expect(html).toContain('href="/blog/early-kody-users#josh-tomaino"')
	expect(html).toContain('href="/blog/early-kody-users#jett-hays"')
	expect(html).toContain('Read the full story')
	expect(html).toContain('from Josh Tomaino')
	expect(html).toContain('from Jett Hays')
})

test('early-users blog post SSR renders approved vignettes and heading anchors', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const post = getBlogPost(landingTestimonialsStorySlug)
	expect(post).toBeDefined()
	const env = createTestEnv()
	const response = await createBlogPostHandler(env).handler({
		request: new Request(
			`https://example.com/blog/${landingTestimonialsStorySlug}`,
		),
		params: { slug: landingTestimonialsStorySlug },
	} as never)
	expect(response.status).toBe(200)
	const html = await response.text()

	expect(html).toContain('Early Kody users')
	expect(html).toContain('id="josh-tomaino"')
	expect(html).toContain('id="jett-hays"')
	expect(html).toContain('funnels all my tools into one secure MCP')
	expect(html).toContain("world's most endangered species")
	expect(getReadNextBlogPost(landingTestimonialsStorySlug)).not.toBeNull()
})
