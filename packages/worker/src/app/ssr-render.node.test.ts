import { expect, test, vi } from 'vitest'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'
import {
	createAuthCookie,
	resetAuthSessionSecretForTests,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountHandler } from '#app/handlers/account.ts'
import { createCommunityHandler } from '#app/handlers/community.tsx'
import { createCommunityDetailHandler } from '#app/handlers/community-detail.tsx'
import { createOnboardingHandler } from '#app/handlers/onboarding.ts'
import { createResetPasswordHandler } from '#app/handlers/reset-password.ts'
import { resetInlineStylesheetCache } from '#app/inline-stylesheet.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { planLimits } from '#worker/entitlements/plans.ts'
import { formatLimitBytes } from '#client/routes/pricing.tsx'
import {
	getReadNextBlogPost,
	listBlogPosts,
	toBlogPostSummary,
} from '#worker/blog/catalog.ts'
import {
	BLOG_PLACEHOLDER_CALLOUT,
	formatBlogPostDate,
} from '#app/blog-display.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const communityMockModule = vi.hoisted(() => ({
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
	getCommunityListingWithAggregates: vi.fn(),
	getUserSocialRowByUsername: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityListingsWithAggregates: (...args: Array<unknown>) =>
		communityMockModule.listCommunityListingsWithAggregates(...args),
	searchCommunityListings: (...args: Array<unknown>) =>
		communityMockModule.searchCommunityListings(...args),
	getCommunityListingWithAggregates: (...args: Array<unknown>) =>
		communityMockModule.getCommunityListingWithAggregates(...args),
	reportCommunityListing: vi.fn(),
	listFeaturedCommunityListingsWithAggregates: vi.fn(async () => []),
}))

vi.mock('#worker/community/social-repo.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/community/social-repo.ts')>()
	return {
		...actual,
		getCommunityStar: vi.fn().mockResolvedValue(false),
		getUserFollow: vi.fn().mockResolvedValue(false),
		getUserSocialRowByUsername: (...args: Array<unknown>) =>
			communityMockModule.getUserSocialRowByUsername(...args),
	}
})

const sampleListing = {
	id: 'listing-1',
	ownerUserId: 'owner-mcp-id',
	packageId: 'pkg-1',
	sourceId: 'src-1',
	kodyId: 'github-triage',
	name: '@kentcdodds/github-triage',
	description: 'Triage GitHub issues.',
	tags: ['github'],
	searchText: null,
	readmeContent: '# README',
	license: 'MIT',
	pinnedCommit: 'abc1234567890',
	iconCommit: 'abc1234567890',
	status: 'active',
	trustedCommit: null,
	trustedAt: null,
	trusted: false,
	featuredAt: null,
	featured: false,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
	starCount: 0,
} satisfies CommunityListingWithAggregates

type TestUser = {
	id: number
	email: string
	username: string
	password_hash: string
	stable_user_id: string
	created_at: string
	updated_at: string
}

function createUserTestDb(users: Array<TestUser>) {
	const userRecords = new Map(users.map((user) => [user.id, { ...user }]))

	function createStatement(query: string, params: Array<unknown> = []) {
		const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
		const executeAll = async () => {
			if (
				normalizedQuery.startsWith('select') &&
				normalizedQuery.includes('from "users"') &&
				/"stable_user_id"\s*=/.test(normalizedQuery)
			) {
				const user = [...userRecords.values()].find(
					(row) => row.stable_user_id === params[0],
				)
				return {
					results: user ? [{ ...user }] : [],
					meta: { changes: 0, last_row_id: 0 },
				}
			}
			if (normalizedQuery.includes('from user_roles')) {
				return {
					results: [],
					meta: { changes: 0, last_row_id: 0 },
				}
			}
			// Feature-flag evaluation during SSR session load; empty state uses
			// registry defaults without throwing.
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
			bind(...nextParams: Array<unknown>) {
				return createStatement(query, nextParams)
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
		// Feature-flag exposure recording upserts via db.batch in local mode.
		async batch(statements: Array<unknown>) {
			return statements.map(() => ({ meta: { changes: 1 } }))
		},
		async exec() {
			return
		},
	} as unknown as D1Database
}

function createTestEnv(db: D1Database) {
	return {
		COOKIE_SECRET: testCookieSecret,
		SECRET_STORE_KEY: 'LOCAL_TEST_SECRET_STORE_KEY_32_CHARS_MINIMUM',
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: {},
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		PACKAGE_SERVICE_INSTANCE: {},
		MCP_CLIENT_HUB: {},
	} as unknown as Env
}

async function readResponseText(response: Response) {
	return await response.text()
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
					url: string
					session: unknown
					loaderData?: Record<string, unknown>
					notFound?: boolean
				}
			}
		>
	}
}

function readAppRootProps(html: string) {
	const rmxData = parseRmxData(html)
	const entry = Object.values(rmxData.h)[0]
	if (!entry) {
		throw new Error('AppRoot hydration entry not found in rmx-data')
	}
	return entry.props
}

async function runHtmlHandler(
	handler: { handler: (context: never) => Promise<Response> },
	request: Request,
) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

test('SSR HTML routes render page content and embedded loader data', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv(
		createUserTestDb([
			{
				id: 1,
				email: 'user@example.com',
				username: 'account-user',
				password_hash: 'unused',
				stable_user_id: testStableUserIdFromEmail('user@example.com'),
				created_at: new Date(0).toISOString(),
				updated_at: new Date(0).toISOString(),
			},
		]),
	)

	communityMockModule.listCommunityListingsWithAggregates.mockResolvedValue([
		sampleListing,
	])

	const communityResponse = await runHtmlHandler(
		createCommunityHandler(env),
		new Request('https://example.com/community'),
	)
	expect(communityResponse.status).toBe(200)
	expect(communityResponse.headers.get('Content-Type')).toContain('text/html')
	const communityHtml = await readResponseText(communityResponse)
	// The card name breaks after the scope slash (`@scope/<wbr />name`).
	expect(communityHtml).toContain('@kentcdodds/<wbr />github-triage')
	expect(communityHtml).toContain('Triage GitHub issues.')
	expect(communityHtml).toContain('data-testid="community-listings-frame"')
	expect(communityHtml).not.toContain('Loading community packages')
	expect(communityHtml).toContain('<!-- rmx:h:')
	const communityProps = readAppRootProps(communityHtml)
	expect(communityProps.loaderData?.community).toBeUndefined()

	const communityFrameResponse = await runHtmlHandler(
		createCommunityHandler(env),
		new Request('https://example.com/community', {
			headers: { 'x-remix-target': 'community-listings' },
		}),
	)
	expect(communityFrameResponse.status).toBe(200)
	expect(communityFrameResponse.headers.get('Cache-Control')).toBe('no-store')
	const communityFrameHtml = await readResponseText(communityFrameResponse)
	expect(communityFrameHtml).toContain('data-testid="community-listings-frame"')
	expect(communityFrameHtml).toContain('@kentcdodds/<wbr />github-triage')
	expect(communityFrameHtml).not.toContain('<html')

	const accountCookie = await createAuthCookie(
		{
			stableUserId: testStableUserIdFromEmail('user@example.com'),
			email: 'user@example.com',
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)
	const accountResponse = await runHtmlHandler(
		createAccountHandler(env),
		new Request('https://example.com/account', {
			headers: { Cookie: accountCookie },
		}),
	)
	expect(accountResponse.status).toBe(200)
	const accountHtml = await readResponseText(accountResponse)
	expect(accountHtml).toContain('>Account</h1>')
	expect(accountHtml).toContain('aria-label="Account sections"')
	expect(accountHtml).toContain('Email: user@example.com')
	expect(accountHtml).not.toContain('Loading account')
	const accountProps = readAppRootProps(accountHtml)
	expect(accountProps.loaderData?.accountProfile).toEqual({
		ok: true,
		email: 'user@example.com',
		emailVerified: false,
		username: 'account-user',
		displayName: 'account-user',
		bio: null,
		avatarUrl: null,
		profileVisibility: 'public',
	})
	expect(accountProps.loaderData?.accountConnections).toEqual({
		ok: true,
		connections: [],
		canDisconnect: false,
		availableProviders: [],
	})
	expect(accountProps.loaderData?.onboarding).toEqual({
		ok: true,
		loggedIn: true,
		mcpServerUrl: '',
		setupPrompt: '',
		discoveryPrompt: expect.stringContaining('what-is-kody'),
		introEmailPrompt: '',
		introEmailLookupPrompt: '',
		hasSentWelcomeEmail: false,
		hasMcpClient: false,
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		checklist: null,
	})
	expect(accountHtml).toContain('Verify your email')
	expect(accountHtml).toContain('No accounts connected yet.')
	expect(accountHtml).not.toContain('Loading connected accounts')
	expect(accountHtml).not.toContain('Connect your AI agent')
	expect(accountHtml).toContain('/pending-verification')

	const accountLinkedResponse = await runHtmlHandler(
		createAccountHandler(env),
		new Request('https://example.com/account?oauthLinked=google', {
			headers: { Cookie: accountCookie },
		}),
	)
	expect(accountLinkedResponse.status).toBe(200)
	const accountLinkedHtml = await readResponseText(accountLinkedResponse)
	expect(accountLinkedHtml).toContain('Google connected.')
	expect(accountLinkedHtml).toContain('No accounts connected yet.')

	const onboardingResponse = await runHtmlHandler(
		createOnboardingHandler(env),
		new Request('https://example.com/onboarding', {
			headers: { Cookie: accountCookie },
		}),
	)
	expect(onboardingResponse.status).toBe(302)
	expect(onboardingResponse.headers.get('Location')).toBe(
		'https://example.com/pending-verification',
	)

	const onboardingPreservesRedirect = await runHtmlHandler(
		createOnboardingHandler(env),
		new Request(
			'https://example.com/onboarding?redirectTo=%2Foauth%2Fauthorize%3Fclient_id%3Ddemo',
			{ headers: { Cookie: accountCookie } },
		),
	)
	expect(onboardingPreservesRedirect.status).toBe(302)
	expect(onboardingPreservesRedirect.headers.get('Location')).toBe(
		'https://example.com/pending-verification?redirectTo=%2Foauth%2Fauthorize%3Fclient_id%3Ddemo',
	)

	const anonymousOnboardingResponse = await runHtmlHandler(
		createOnboardingHandler(env),
		new Request('https://example.com/onboarding'),
	)
	expect(anonymousOnboardingResponse.status).toBe(200)

	const anonymousAccountResponse = await runHtmlHandler(
		createAccountHandler(env),
		new Request('https://example.com/account'),
	)
	expect(anonymousAccountResponse.status).toBe(302)
	expect(anonymousAccountResponse.headers.get('Location')).toBe(
		'https://example.com/login?redirectTo=%2Faccount',
	)

	const notFoundResponse = await renderAppPage({
		request: new Request('https://example.com/missing-page'),
		env,
		title: 'Not found',
		notFound: true,
		status: 404,
	})
	expect(notFoundResponse.status).toBe(404)
	const notFoundHtml = await readResponseText(notFoundResponse)
	expect(notFoundHtml).toContain('Not Found')
	expect(readAppRootProps(notFoundHtml).notFound).toBe(true)

	const resetConfirmResponse = await runHtmlHandler(
		createResetPasswordHandler(env),
		new Request('https://example.com/reset-password?token=reset-token'),
	)
	expect(resetConfirmResponse.status).toBe(200)
	const resetConfirmHtml = await readResponseText(resetConfirmResponse)
	expect(resetConfirmHtml).toContain('Choose a new password')
	expect(resetConfirmHtml).toContain('New password')
	expect(resetConfirmHtml).not.toContain('Send reset link')
	expect(readAppRootProps(resetConfirmHtml).url).toBe(
		'/reset-password?token=reset-token',
	)
})

test('renderAppPage embeds the Fathom tracker only when FATHOM_SITE_ID is set', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv(createUserTestDb([]))

	const withoutFathom = await renderAppPage({
		request: new Request('https://example.com/login'),
		env,
	})
	expect(withoutFathom.status).toBe(200)
	const withoutFathomHtml = await readResponseText(withoutFathom)
	expect(withoutFathomHtml).not.toContain('cdn.usefathom.com')

	const whitespaceOnly = await renderAppPage({
		request: new Request('https://example.com/login'),
		env: { ...env, FATHOM_SITE_ID: '   ' } as Env,
	})
	expect(await readResponseText(whitespaceOnly)).not.toContain(
		'cdn.usefathom.com',
	)

	const padded = await renderAppPage({
		request: new Request('https://example.com/login'),
		env: { ...env, FATHOM_SITE_ID: ' WKKSDJGN ' } as Env,
	})
	expect(await readResponseText(padded)).toContain('data-site="WKKSDJGN"')

	const withFathom = await renderAppPage({
		request: new Request('https://example.com/login'),
		env: { ...env, FATHOM_SITE_ID: 'WKKSDJGN' } as Env,
	})
	expect(withFathom.status).toBe(200)
	const withFathomHtml = await readResponseText(withFathom)
	expect(withFathomHtml).toContain('https://cdn.usefathom.com/script.js')
	expect(withFathomHtml).toContain('data-site="WKKSDJGN"')
	expect(withFathomHtml).toContain('data-spa="auto"')
	const csp = withFathom.headers.get('Content-Security-Policy')
	expect(csp).toContain(
		"script-src 'self' https://cdn.usefathom.com https://static.cloudflareinsights.com",
	)
	expect(csp).toContain("img-src 'self' data: blob: https://cdn.usefathom.com")
	expect(csp).toContain("connect-src 'self' https://cloudflareinsights.com")
})

test('renderAppPage emits a doctype, meta description, and inlines the stylesheet when assets provide it', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	resetInlineStylesheetCache()
	const env = createTestEnv(createUserTestDb([]))

	// Without an ASSETS binding: doctype plus the stylesheet <link> fallback.
	const withoutAssets = await renderAppPage({
		request: new Request('https://example.com/'),
		env,
	})
	const withoutAssetsHtml = await readResponseText(withoutAssets)
	expect(withoutAssetsHtml.startsWith('<!DOCTYPE html>')).toBe(true)
	expect(withoutAssetsHtml).toContain('href="/styles.css')
	expect(withoutAssetsHtml).toContain('name="description"')

	// With ASSETS serving the stylesheet: inline <style>, no stylesheet link.
	const assets = {
		fetch: async (request: Request) =>
			new URL(request.url).pathname === '/styles.css'
				? new Response(':root { --inline-marker: 1; }')
				: new Response('not found', { status: 404 }),
	}
	const withAssets = await renderAppPage({
		request: new Request('https://example.com/'),
		env: { ...env, ASSETS: assets } as Env,
	})
	const withAssetsHtml = await readResponseText(withAssets)
	expect(withAssetsHtml).toContain(
		'<style>:root { --inline-marker: 1; }</style>',
	)
	expect(withAssetsHtml).not.toContain('href="/styles.css')

	// CSS needing HTML escaping must fall back to the <link> (the stream
	// renderer escapes text children, which would corrupt selectors).
	resetInlineStylesheetCache()
	const unsafeAssets = {
		fetch: async () => new Response('.card > p { color: red; }'),
	}
	const withUnsafeCss = await renderAppPage({
		request: new Request('https://example.com/'),
		env: { ...env, ASSETS: unsafeAssets } as Env,
	})
	const withUnsafeCssHtml = await readResponseText(withUnsafeCss)
	expect(withUnsafeCssHtml).toContain('href="/styles.css')
	expect(withUnsafeCssHtml).not.toContain('.card &gt; p')
})

test('renderAppPage configures session secret before reading cookies', async () => {
	resetDataCacheForTests()
	resetAuthSessionSecretForTests()
	const env = createTestEnv(createUserTestDb([]))

	const response = await renderAppPage({
		request: new Request('https://example.com/oauth/authorize', {
			headers: { Cookie: 'kody_session=stale-or-unsigned; other=1' },
		}),
		env,
		loaderData: {
			oauthAuthorize: {
				ok: true,
				client: { id: 'client-1', name: 'Cursor' },
				scopes: ['profile', 'email'],
			},
		},
	})

	expect(response.status).toBe(200)
	const html = await readResponseText(response)
	expect(html).toContain('Authorize access')
	expect(html).not.toContain('OAuth authorization failed')
})

test('renderAppPage renders the redesigned landing page shell', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv(createUserTestDb([]))

	const response = await renderAppPage({
		request: new Request('https://example.com/'),
		env,
	})

	expect(response.status).toBe(200)
	const html = await readResponseText(response)
	// Theme pre-paint script (blocking, CSP-safe external file).
	expect(html).toContain('src="/theme-init.js"')
	expect(html).toContain('/images/hero/kody-base.webp')
	expect(html).toContain('aria-label="Main"')
	expect(html).toContain('aria-label="Footer"')
	expect(html).toContain('aria-label="Dark mode"')
	expect(html).toContain('id="invite"')
})

test('renderAppPage renders the redesigned pricing page', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv(createUserTestDb([]))

	const response = await renderAppPage({
		request: new Request('https://example.com/pricing'),
		env,
	})

	expect(response.status).toBe(200)
	const html = await readResponseText(response)
	// Self-serve tiers + limits table sourced from plans.ts.
	expect(html).toContain('Free')
	expect(html).toContain('Standard')
	expect(html).toContain('Pro')
	expect(html).toContain(String(planLimits.free.maxSavedPackages))
	expect(html).toContain(String(planLimits.standard.maxSavedPackages))
	expect(html).toContain(String(planLimits.pro.maxSavedPackages))
	expect(html).toContain(formatLimitBytes(planLimits.free.maxEmailMessageBytes))
	expect(html).toContain(formatLimitBytes(planLimits.pro.maxStorageBytes))
})

test('renderAppPage renders the redesigned blog index', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv(createUserTestDb([]))

	const posts = listBlogPosts().map(toBlogPostSummary)
	const response = await renderAppPage({
		request: new Request('https://example.com/blog'),
		env,
		loaderData: { blog: { ok: true, posts } },
	})

	expect(response.status).toBe(200)
	const html = await readResponseText(response)
	expect(html).toContain('href="/blog/rss.xml"')
	expect(html).toContain('/images/kody-agent-briefing.webp')
	expect(posts.length).toBeGreaterThan(0)
	for (const post of posts) {
		expect(html).toContain(`href="/blog/${post.slug}"`)
	}
	const newest = posts[0]
	expect(newest).toBeDefined()
	expect(html).toContain(formatBlogPostDate(newest!.date))
})

test('community detail SSR renders the redesigned article', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv(createUserTestDb([]))

	const detailListing = {
		...sampleListing,
		id: 'listing-detail-1',
		trusted: true,
		trustedCommit: 'abc1234567890',
		trustedAt: '2026-01-02T00:00:00.000Z',
		readmeContent:
			'# @kentcdodds/github-triage\n\n## Intent\n\nTriage GitHub issues for me.\n\n## Exports\n\n- `./triage` — run the triage pass.',
	} satisfies CommunityListingWithAggregates
	communityMockModule.getCommunityListingWithAggregates.mockResolvedValue(
		detailListing,
	)
	communityMockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'public',
		stable_user_id: 'owner-mcp-id',
	})

	const response = await createCommunityDetailHandler(env).handler({
		request: new Request('https://example.com/community/listing-detail-1'),
		url: new URL('https://example.com/community/listing-detail-1'),
		params: { listingId: 'listing-detail-1' },
	} as never)

	expect(response.status).toBe(200)
	const html = await readResponseText(response)
	// Server frame head: back link, icon well, name (scope-slash break),
	// author, trusted badge, tags, quiet meta row.
	expect(html).toContain('data-testid="community-detail-frame"')
	expect(html).toContain('Community packages')
	expect(html).toContain('data-testid="community-listing-icon-detail"')
	expect(html).toContain('/community/listing-detail-1/icon/abc1234567890')
	expect(html).toContain('@kentcdodds/<wbr />github-triage')
	expect(html).toContain('by ')
	expect(html).toContain('href="/@kentcdodds"')
	expect(html).toContain('>@kentcdodds</a>')
	expect(html).toContain('data-testid="community-detail-owner-follow"')
	expect(html).not.toContain('data-testid="community-detail-owner-private"')
	expect(html).toContain('data-testid="community-detail-trusted-badge"')
	expect(html).toContain('License')
	expect(html).toContain('MIT')
	expect(html).toContain('abc1234')
	expect(html).toContain('★ 4.5 (2)')
	expect(html).toContain('data-testid="community-detail-forks"')
	// README renders as prose with h3 subheads (## Intent → h3).
	expect(html).toContain('data-testid="community-readme"')
	expect(html).toContain('<h3>Intent</h3>')
	expect(html).toContain('Triage GitHub issues for me.')
	expect(html).toContain('<details')
	// Loader data embeds the shell payload for hydration.
	const props = readAppRootProps(html)
	expect(props.loaderData?.communityDetailShell).toMatchObject({
		ok: true,
		listingId: 'listing-detail-1',
		name: '@kentcdodds/github-triage',
		trusted: true,
	})
})

test('renderAppPage renders the redesigned blog post', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv(createUserTestDb([]))

	// A real catalog post whose own title and read-next title carry no
	// apostrophes (JSX escaping would rewrite them in the HTML output).
	const post = listBlogPosts().find(
		(candidate) => candidate.slug === 'every-install-is-a-fork-you-own',
	)
	expect(post).toBeDefined()
	const readNext = getReadNextBlogPost(post!.slug)
	expect(readNext).not.toBeNull()

	const response = await renderAppPage({
		request: new Request(`https://example.com/blog/${post!.slug}`),
		env,
		loaderData: {
			blogPost: {
				ok: true,
				slug: post!.slug,
				title: post!.title,
				date: post!.date,
				description: post!.description,
				body: post!.body,
				readNext,
			},
		},
	})

	expect(response.status).toBe(200)
	const html = await readResponseText(response)
	expect(html).toContain(`href="/blog"`)
	expect(html).toContain(post!.title)
	expect(html).toContain(formatBlogPostDate(post!.date))
	expect(html).toContain(BLOG_PLACEHOLDER_CALLOUT)
	// Markdown body renders in the prose voice: authored `##` stays h2 (not
	// the README demotion to h4) and first-party links skip the ugc rel.
	expect(html).toMatch(/<h2[^>]*>/)
	expect(html).not.toMatch(/<h4[^>]*>/)
	expect(html).not.toContain('nofollow ugc')
	expect(html).toContain(`href="/blog/${readNext!.slug}"`)
	expect(html).toContain(readNext!.title)
	expect(html).toContain('/images/kody-greeting.webp')
	expect(html).toContain('href="/#invite"')
})
