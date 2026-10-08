import { expect, test, vi } from 'vitest'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'
import {
	createAuthCookie,
	resetAuthSessionSecretForTests,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountHandler } from '#app/handlers/account.ts'
import { createAccountConnectionsHandler } from '#app/handlers/account-connected-agents.ts'
import { createAccountPasskeysHandler } from '#app/handlers/account-passkeys.ts'
import { createAccountMcpOauthClientsHandler } from '#app/handlers/account-mcp-oauth-clients.ts'
import { createAccountTwoFactorHandler } from '#app/handlers/account-two-factor.ts'
import { createAccountWaitingHandler } from '#app/handlers/account-waiting.ts'
import { createCommunityHandler } from '#app/handlers/community.tsx'
import {
	createCommunityDetailHandler,
	createCommunityPackageHandler,
} from '#app/handlers/community-detail.tsx'
import { createOnboardingHandler } from '#app/handlers/onboarding.ts'
import { createPendingVerificationHandler } from '#app/handlers/pending-verification.ts'
import { createResetPasswordHandler } from '#app/handlers/reset-password.ts'
import { resetInlineStylesheetCache } from '#app/inline-stylesheet.ts'
import {
	renderAppPage,
	resolveOriginClientEntry,
	type RenderAppPageInput,
} from '#app/ssr-render.tsx'
import {
	getReadNextBlogPost,
	listBlogPosts,
	toBlogPostSummary,
} from '#worker/blog/catalog.ts'
import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
import { firstPartySecurityHeaders } from '#app/security-headers.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { BLOG_PLACEHOLDER_CALLOUT } from '#universal/blog-display.ts'
import {
	type AccountIntegrationListItem,
	type AccountOauthAppListItem,
	type ConnectOauthLoaderData,
} from '#universal/loader-data.ts'
import { getScrollRestorationInlineScript } from '#universal/router-scroll-restoration.ts'
import type * as CommunityProfileRepo from '#worker/community/profile-repo.ts'
import type * as PackageUrlModule from '#worker/community/package-url.ts'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const communityMockModule = vi.hoisted(() => ({
	listCommunityIndexOverview: vi.fn(),
	getCommunityCategoryCounts: vi.fn(),
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
	getCommunityListingWithAggregates: vi.fn(),
	getUserSocialRowByUsername: vi.fn(),
	resolveCommunityListingRoute: vi.fn(),
	resolveCanonicalListingPath: vi.fn(),
	resolvePackagePageUrl: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityIndexOverview: (...args: Array<unknown>) =>
		communityMockModule.listCommunityIndexOverview(...args),
	getCommunityCategoryCounts: (...args: Array<unknown>) =>
		communityMockModule.getCommunityCategoryCounts(...args),
	listCommunityListingsWithAggregates: (...args: Array<unknown>) =>
		communityMockModule.listCommunityListingsWithAggregates(...args),
	searchCommunityListings: (...args: Array<unknown>) =>
		communityMockModule.searchCommunityListings(...args),
	getCommunityListingWithAggregates: (...args: Array<unknown>) =>
		communityMockModule.getCommunityListingWithAggregates(...args),
	reportCommunityListing: vi.fn(),
	listFeaturedCommunityListingsWithAggregates: vi.fn(async () => []),
	getCommunityListingsByIds: vi.fn(async () => []),
}))

// Owner/kody-id resolution is covered against the real schema in
// `community/package-url` tests; here it only has to hand the handler a
// listing id so the page itself can be rendered.
vi.mock('#app/community-package-route.ts', () => ({
	resolveCommunityListingRoute: (...args: Array<unknown>) =>
		communityMockModule.resolveCommunityListingRoute(...args),
	resolveCanonicalListingPath: (...args: Array<unknown>) =>
		communityMockModule.resolveCanonicalListingPath(...args),
}))

vi.mock('#worker/community/package-url.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PackageUrlModule>()
	return {
		...actual,
		resolvePackagePageUrl: (...args: Array<unknown>) =>
			communityMockModule.resolvePackagePageUrl(...args),
	}
})

vi.mock('#worker/community/profile-repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof CommunityProfileRepo>()
	return {
		...actual,
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
	category: 'integrations',
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

function makeUser(email: string, username: string): TestUser {
	return {
		id: 1,
		email,
		username,
		password_hash: 'unused',
		stable_user_id: testStableUserIdFromEmail(email),
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
	}
}

const accountUser = () => makeUser('user@example.com', 'account-user')

function createUserTestDb(users: Array<TestUser>) {
	const userRecords = new Map(users.map((user) => [user.id, { ...user }]))
	const empty = { results: [], meta: { changes: 0, last_row_id: 0 } }

	// Only the session user lookup returns rows; roles and feature flags stay
	// empty so SSR session load uses registry defaults without throwing.
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
				return { ...empty, results: user ? [{ ...user }] : [] }
			}
			return empty
		}
		return {
			query,
			bind(...nextParams: Array<unknown>) {
				return createStatement(query, nextParams)
			},
			all: executeAll,
			async first() {
				return (await executeAll()).results[0] ?? null
			},
			async run() {
				return { meta: { changes: 0, last_row_id: 0 } }
			},
		}
	}

	return {
		prepare: (query: string) => createStatement(query),
		batch: (statements: Array<{ query?: string }>) =>
			executePreparedD1Batch(statements),
		async exec() {},
	} as unknown as D1Database
}

function setupEnv(users: Array<TestUser> = []) {
	invalidateCommunityPublicCache()
	setAuthSessionSecret(testCookieSecret)
	return {
		COOKIE_SECRET: testCookieSecret,
		SECRET_STORE_KEY: 'LOCAL_TEST_SECRET_STORE_KEY_32_CHARS_MINIMUM',
		...testOidcSigningEnv,
		APP_DB: createUserTestDb(users),
		BUNDLE_ARTIFACTS_KV: createMemoryKv(),
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		MCP_CLIENT_HUB: {},
	} as unknown as Env
}

function cookieFor(email = 'user@example.com') {
	return createAuthCookie(
		{
			stableUserId: testStableUserIdFromEmail(email),
			email,
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)
}

function get(path: string, cookie?: string, headers = {}) {
	return new Request(`https://example.com${path}`, {
		headers: cookie ? { ...headers, Cookie: cookie } : headers,
	})
}

async function render(
	env: Env,
	path: string,
	options: {
		cookie?: string
		loaderData?: RenderAppPageInput['loaderData']
	} = {},
) {
	const response = await renderAppPage({
		request: get(path, options.cookie),
		env,
		loaderData: options.loaderData,
	})
	return { response, html: await response.text() }
}

type HtmlHandler = { handler: (context: never) => Promise<Response> }

async function runHtml(
	handler: HtmlHandler,
	request: Request,
	params: Record<string, string> = {},
) {
	const response = await handler.handler({
		request,
		url: new URL(request.url),
		params,
	} as never)
	return { response, html: await response.text() }
}

function expectHtml(
	html: string,
	present: Array<string>,
	absent: Array<string> = [],
) {
	expect(present.filter((snippet) => !html.includes(snippet))).toEqual([])
	expect(absent.filter((snippet) => html.includes(snippet))).toEqual([])
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
				exportName?: string
				moduleUrl?: string
				props: {
					url: string
					session: unknown
					loaderData?: Record<string, unknown>
					notFound?: boolean
					internalError?: boolean
				}
			}
		>
	}
}

function readAppRootProps(html: string) {
	const entry = Object.values(parseRmxData(html).h)[0]
	if (!entry) {
		throw new Error('AppRoot hydration entry not found in rmx-data')
	}
	return entry.props
}

const emptyAccountConnections = {
	ok: true,
	connections: [],
	canDisconnect: false,
	hasUsablePassword: false,
	availableProviders: [],
	canSyncDiscordRoles: false,
}

test('resolveOriginClientEntry maps Remix entry IDs onto the Vite client href', () => {
	const href = '/assets/entry-DU-pHDbL.js'
	expect(
		resolveOriginClientEntry({
			entryId: '/client-entry.js#AppRoot',
			href,
			preloads: ['/assets/auth-area-BZaLSnX1.js'],
		}),
	).toEqual({
		href,
		exportName: 'AppRoot',
		preloads: ['/assets/auth-area-BZaLSnX1.js'],
	})
	expect(
		resolveOriginClientEntry({
			entryId: 'file:///app/app-root.tsx',
			href,
			preloads: [],
		}),
	).toEqual({ href, exportName: 'AppRoot', preloads: [] })
	// Pitlane's dev `<HMR />` island names its own dev-server module; the client
	// entry bundle does not export it.
	expect(
		resolveOriginClientEntry({
			entryId: '/@id/__x00__pitlane:dev#HMR',
			href: '/packages/worker/client/entry.tsx',
			preloads: ['/packages/worker/client/routes/auth-area.ts'],
		}),
	).toEqual({
		href: '/@id/__x00__pitlane:dev',
		exportName: 'HMR',
		preloads: [],
	})
})

test('SSR HTML routes render page content and embedded loader data', async () => {
	const env = setupEnv([accountUser()])
	communityMockModule.listCommunityIndexOverview.mockResolvedValue({
		listings: [sampleListing],
		groups: [{ category: 'integrations', listings: [sampleListing], total: 1 }],
		categoryCounts: {
			integrations: 1,
			examples: 0,
			productivity: 0,
			apps: 0,
			utilities: 0,
			other: 0,
		},
	})

	const community = await runHtml(
		createCommunityHandler(env),
		get('/community'),
	)
	expect(community.response.status).toBe(200)
	expect(community.response.headers.get('Content-Type')).toContain('text/html')
	expectHtml(
		community.html,
		[
			'data-testid="community-listings-frame"',
			'@kentcdodds/github-triage',
			'data-rmx-target="community-listings"',
			'data-rmx-history="push"',
			'<!-- rmx:h:',
		],
		['data-testid="community-listings-empty"'],
	)
	const communityEntry = Object.values(parseRmxData(community.html).h)[0]
	expect(communityEntry?.exportName).toBe('AppRoot')
	expect(communityEntry?.moduleUrl).toBe('/client-entry.js')
	expect(communityEntry?.props.loaderData?.community).toBeUndefined()
	expect(communityMockModule.listCommunityIndexOverview).toHaveBeenCalledTimes(
		1,
	)

	const communityFrame = await runHtml(
		createCommunityHandler(env),
		get('/community', undefined, { 'x-remix-target': 'community-listings' }),
	)
	expect(communityFrame.response.status).toBe(200)
	expect(communityFrame.response.headers.get('Cache-Control')).toBe('no-store')
	expectHtml(
		communityFrame.html,
		['data-testid="community-listings-frame"'],
		['<html'],
	)

	const cookie = await cookieFor()
	const signedIn = async (create: (env: Env) => HtmlHandler, path: string) => {
		const page = await runHtml(create(env), get(path, cookie))
		return { ...page, loaderData: readAppRootProps(page.html).loaderData }
	}

	const account = await signedIn(createAccountHandler, '/account')
	expect(account.response.status).toBe(200)
	// Connected agents moved to `/account/connections`; Overview only links
	// there. The rail carries Connections and Repositories (the profile is the
	// canonical repository list, so the nav links there rather than the
	// `/account/packages` redirect).
	expectHtml(
		account.html,
		[
			'aria-label="Account sections"',
			'data-testid="site-header-account"',
			'data-testid="site-header-profile"',
			'data-testid="site-header-account-menu"',
			'href="/@account-user"',
			'aria-label="@account-user"',
			'data-testid="account-connections-link"',
			'href="/account/connections"',
			'>Connections</a>',
			'data-icon="link"',
			'data-icon="box"',
			'/pending-verification',
			'action="/logout"',
			'aria-label="Session"',
		],
		['aria-label="Connected agents"'],
	)
	expect(account.html).toMatch(
		/href="\/@account-user"[^>]*>[\s\S]*?Repositories<\/a>/,
	)
	expect(account.loaderData?.accountProfile).toEqual({
		ok: true,
		email: 'user@example.com',
		emailVerified: false,
		emailVerificationDelivery: null,
		username: 'account-user',
		displayName: 'account-user',
		bio: null,
		avatarUrl: null,
		profileVisibility: 'public',
		formerEmails: [],
	})
	expect(account.loaderData?.accountConnections).toEqual(
		emptyAccountConnections,
	)
	expect(account.loaderData?.accountConnectedAgents).toBeUndefined()
	expect(account.loaderData?.onboarding).toEqual({
		ok: true,
		loggedIn: true,
		username: 'account-user',
		mcpServerUrl: '',
		setupPrompt: '',
		discoveryPrompt: expect.stringContaining('what-is-kody'),
		persistPrompt: '',
		hasAccessWin: false,
		hasSecondMcpClient: false,
		hasMcpClient: false,
		connectedAgents: [],
		secondAgentStandardGift: {
			received: false,
			active: false,
			status: 'none',
			expiresAt: null,
			grantedAt: null,
		},
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		featuredMcpServers: [],
		customMcpServers: [],
		featuredPlatformIntegrations: [],
		persistedPackageName: null,
		accessWinMemorySubject: null,
		checklist: null,
	})

	const pendingVerification = await signedIn(
		createPendingVerificationHandler,
		'/pending-verification',
	)
	expect(pendingVerification.response.status).toBe(200)
	expectHtml(pendingVerification.html, [
		'src="/images/kody-envelope.png"',
		'data-testid="pending-verification-page"',
	])
	expect(pendingVerification.loaderData?.pendingVerification).toEqual({
		ok: true,
		email: 'user@example.com',
		emailVerificationDelivery: null,
	})

	// Two-factor, passkeys, waiting, and MCP OAuth clients embed the same
	// payload their .json endpoints serve, so each page server-renders its real
	// state instead of a loading placeholder plus a client fetch.
	const twoFactor = await signedIn(
		createAccountTwoFactorHandler,
		'/account/two-factor',
	)
	expect(twoFactor.response.status).toBe(200)
	expect(twoFactor.loaderData?.accountTwoFactor).toEqual({
		ok: true,
		enabled: false,
	})
	expect(twoFactor.html).not.toContain('action="/logout"')
	const passkeys = await signedIn(
		createAccountPasskeysHandler,
		'/account/passkeys',
	)
	expect(passkeys.response.status).toBe(200)
	expect(passkeys.loaderData?.accountPasskeys).toEqual({
		ok: true,
		passkeys: [],
	})
	const waiting = await signedIn(
		createAccountWaitingHandler,
		'/account/waiting',
	)
	expect(waiting.response.status).toBe(200)
	expect(waiting.loaderData?.accountWaiting).toEqual({
		ok: true,
		items: expect.any(Array),
	})
	const mcpOauthClients = await signedIn(
		createAccountMcpOauthClientsHandler,
		'/account/mcp-oauth-clients',
	)
	expect(mcpOauthClients.response.status).toBe(200)
	expect(mcpOauthClients.loaderData?.accountMcpOauthClients).toEqual({
		ok: true,
		clients: [],
	})

	// The Connections page embeds the connected-agents payload. The MCP URL is
	// gated on email verification (this fixture is unverified), so the page
	// server-renders the verify note instead of a copy card.
	const connections = await signedIn(
		createAccountConnectionsHandler,
		'/account/connections',
	)
	expect(connections.response.status).toBe(200)
	expectHtml(connections.html, [
		'aria-label="Account sections"',
		'aria-label="Connected agents"',
		'aria-label="MCP URL"',
		'data-testid="account-connections-verify-note"',
		'href="/account/mcp-oauth-clients"',
		'data-entity-explainer="connections"',
		'data-testid="account-connections-add"',
	])
	expect(connections.html).toMatch(
		/href="\/account\/connections"[^>]*aria-current="page"/,
	)
	expect(connections.loaderData?.accountConnectedAgents).toEqual({
		ok: true,
		agents: [],
		mcpServerUrl: '',
		connectionProfilesEnabled: false,
		connectionProfiles: [],
		connectionProfilePackageOptions: [],
	})

	// `/new` is its own page; the per-agent step shares the handler; unknown
	// agent segments 404 instead of rendering an empty grid.
	const addGrid = await signedIn(
		createAccountConnectionsHandler,
		'/account/connections/new',
	)
	expectHtml(
		addGrid.html,
		['data-testid="account-connections-back"'],
		['aria-label="Connected agents"'],
	)
	const addCursor = await signedIn(
		createAccountConnectionsHandler,
		'/account/connections/new/cursor',
	)
	expect(addCursor.response.status).toBe(200)
	expectHtml(addCursor.html, [
		'<title>Connect Cursor',
		'aria-label="Connect Cursor"',
	])
	expect(addCursor.html).toMatch(
		/href="\/account\/connections"[^>]*aria-current="page"/,
	)
	const unknownAgent = await runHtml(
		createAccountConnectionsHandler(env),
		get('/account/connections/new/not-a-client', cookie),
	)
	expect(unknownAgent.response.status).toBe(404)

	const accountLinked = await signedIn(
		createAccountHandler,
		'/account?oauthLinked=google',
	)
	expect(accountLinked.response.status).toBe(200)
	expect(accountLinked.loaderData?.accountConnections).toEqual(
		emptyAccountConnections,
	)

	const onboardingIndex = await runHtml(
		createOnboardingHandler(env),
		get('/onboarding'),
	)
	expect(onboardingIndex.response.status).toBe(302)
	expect(onboardingIndex.response.headers.get('Location')).toBe(
		'https://example.com/onboarding/step-1',
	)
	const onboarding = await runHtml(
		createOnboardingHandler(env),
		get('/onboarding/step-1'),
	)
	expect(onboarding.response.status).toBe(200)
	expectHtml(onboarding.html, [
		'data-testid="onboarding-join-discord"',
		'data-testid="onboarding-agent-picker"',
		'data-testid="onboarding-step-2"',
		'href="/onboarding/step-2"',
	])
	const positions = [
		'onboarding-steps-nav',
		'onboarding-agent-picker',
		'onboarding-join-discord',
	].map((marker) => onboarding.html.indexOf(marker))
	expect(positions).toEqual([...positions].sort((a, b) => a - b))

	const anonymousAccount = await runHtml(
		createAccountHandler(env),
		get('/account'),
	)
	expect(anonymousAccount.response.status).toBe(302)
	expect(anonymousAccount.response.headers.get('Location')).toBe(
		'https://example.com/login?redirectTo=%2Faccount',
	)

	const notFound = await renderAppPage({
		request: get('/missing-page'),
		env,
		title: 'Not found',
		notFound: true,
		status: 404,
	})
	expect(notFound.status).toBe(404)
	const notFoundHtml = await notFound.text()
	expect(notFoundHtml).toContain('src="/images/kody-404-disappointed.png"')
	expect(readAppRootProps(notFoundHtml).notFound).toBe(true)

	const internalError = await renderAppPage({
		request: get('/account'),
		env,
		title: 'Something went wrong',
		internalError: true,
		status: 500,
	})
	expect(internalError.status).toBe(500)
	const internalErrorHtml = await internalError.text()
	expect(internalErrorHtml).toContain('src="/images/kody-500-zapped.png"')
	expect(readAppRootProps(internalErrorHtml).internalError).toBe(true)

	const resetConfirm = await runHtml(
		createResetPasswordHandler(env),
		get('/reset-password?token=reset-token'),
	)
	expect(resetConfirm.response.status).toBe(200)
	expectHtml(resetConfirm.html, ['New password'], ['Send reset link'])
	expect(readAppRootProps(resetConfirm.html).url).toBe(
		'/reset-password?token=reset-token',
	)
})

test('renderAppPage embeds the Fathom tracker only when FATHOM_SITE_ID is set', async () => {
	const env = setupEnv()
	const withSiteId = (FATHOM_SITE_ID?: string) =>
		renderAppPage({
			request: get('/login'),
			env: { ...env, FATHOM_SITE_ID } as Env,
		})

	for (const siteId of [undefined, '   ']) {
		const response = await withSiteId(siteId)
		expect(response.status).toBe(200)
		expect(await response.text()).not.toContain('cdn.usefathom.com')
	}
	expect(await (await withSiteId(' WKKSDJGN ')).text()).toContain(
		'data-site="WKKSDJGN"',
	)

	const withFathom = await withSiteId('WKKSDJGN')
	expect(withFathom.status).toBe(200)
	expectHtml(await withFathom.text(), [
		'https://cdn.usefathom.com/script.js',
		'data-site="WKKSDJGN"',
		'data-spa="auto"',
	])
	expectHtml(withFathom.headers.get('Content-Security-Policy') ?? '', [
		"script-src 'self' 'sha256-",
		'https://cdn.usefathom.com https://static.cloudflareinsights.com',
		"img-src 'self' data: blob: https://cdn.usefathom.com https://static.scarf.sh",
		"connect-src 'self' https://cdn.usefathom.com https://cloudflareinsights.com",
	])
})

test('anonymous homepage document: doctype, preloads, scroll restoration, loop teaser, and public caching', async () => {
	const env = setupEnv()
	resetInlineStylesheetCache()
	const { response, html } = await render(env, '/')
	expect(response.status).toBe(200)
	expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
	// Without an ASSETS binding the stylesheet stays a <link>. Proof stage: one
	// agent list around Kody, travelling orbs. The factory-loop teaser owns its
	// combined play/pause control (icons, not the word Pause) so the header
	// does not shift when playback starts.
	expectHtml(html, [
		'href="/styles.css',
		'name="description"',
		'src="/page-init.js"',
		'landing-hero-agents',
		'/images/kody-mark.png',
		'landing-hero-agent-light',
		'landing-hero-agent-track',
		'class="landing-path-rail"',
		'href="/images/hero/kody-base-640.webp"',
		'kody-base-960.webp',
		'as="image"',
		'class="landing-loop"',
		'/docs/how-kody-works',
		'class="landing-loop-toggle-slot"',
		'class="landing-loop-toggle"',
		'aria-label="Pause"',
		'aria-label="Skip to the end"',
		'class="landing-loop-status-dot"',
		'href="/docs"',
		'href="/community"',
	])
	expect(html.match(/aria-label="Agents Kody plugs into"/g)).toEqual([
		'aria-label="Agents Kody plugs into"',
	])

	const restoreScriptIndex = html.indexOf(getScrollRestorationInlineScript())
	expect(restoreScriptIndex).toBeGreaterThan(html.indexOf('<div id="root">'))
	expect(restoreScriptIndex).toBeGreaterThan(0)
	expect(html.indexOf('type="module" src="')).toBeGreaterThan(
		restoreScriptIndex,
	)
	expect(response.headers.get('Content-Security-Policy')).toBe(
		firstPartySecurityHeaders['Content-Security-Policy'],
	)
	expect(response.headers.get('Content-Security-Policy')).toContain("'sha256-")

	const timing = response.headers.get('Server-Timing') ?? ''
	expect(timing).toContain('session;dur=')
	expect(timing).toContain('ssr;dur=')
	expect(response.headers.get('Vary')).toBe('Cookie')
	const publicCache = 'public, max-age=60, stale-while-revalidate=300'
	for (const path of [
		'/',
		'/onboarding',
		'/docs/how-kody-works',
		'/login',
		'/signup',
	]) {
		const { response: page, html } = await render(env, path)
		expect(page.headers.get('Cache-Control')).toBe(publicCache)
		expect(page.headers.get('Vary')).toBe('Cookie')
		if (path === '/login' || path === '/signup') {
			const props = readAppRootProps(html)
			expect(props.session).toBeNull()
			expect(html).not.toMatch(/csrf|nonce=/i)
			expect(html).not.toContain('user@example.com')
		}
	}

	// Any session cookie (even stale) stays private; auth paths included.
	for (const [path, cookie] of [
		['/', 'kody_session=stale-or-unsigned'],
		['/', await cookieFor()],
		['/login', 'kody_session=stale-or-unsigned'],
		['/signup', await cookieFor()],
	] as const) {
		const { response: page } = await render(env, path, { cookie })
		expect(page.headers.get('Cache-Control')).toBe('no-store')
	}

	// Anonymous auth HTML is viewer-independent aside from Remix handle ids
	// (same per-render variance already accepted for cached /pricing).
	function normalizeRemixIds(input: string) {
		return input
			.replace(/<!-- rmx:h:h[0-9a-f]+ -->/g, '<!-- rmx:h:HID -->')
			.replace(/"h[0-9a-f]+":\{"exportName"/g, '"HID":{"exportName"')
			.replace(/\bs[0-9a-f]+-\d+/g, 'sHANDLE')
	}
	const loginA = await render(env, '/login')
	const loginB = await render(env, '/login')
	expect(normalizeRemixIds(loginA.html)).toBe(normalizeRemixIds(loginB.html))
	const signupA = await render(env, '/signup')
	const signupB = await render(env, '/signup')
	expect(normalizeRemixIds(signupA.html)).toBe(normalizeRemixIds(signupB.html))
})

test('renderAppPage inlines the stylesheet only when ASSETS serves HTML-safe CSS', async () => {
	const env = setupEnv()
	const renderWithCss = async (css: string) => {
		resetInlineStylesheetCache()
		const assets = {
			fetch: async (request: Request) =>
				new URL(request.url).pathname === '/styles.css'
					? new Response(css)
					: new Response('not found', { status: 404 }),
		}
		const response = await renderAppPage({
			request: get('/'),
			env: { ...env, ASSETS: assets } as Env,
		})
		return await response.text()
	}

	expectHtml(
		await renderWithCss(':root { --inline-marker: 1; }'),
		['<style>:root { --inline-marker: 1; }</style>'],
		['href="/styles.css'],
	)
	// Comments may mention HTML (`<main>`) without blocking inlining.
	expectHtml(
		await renderWithCss(
			'/* The router moves focus to <main> */\n:root { --comment-ok: 1; }',
		),
		['<style>:root { --comment-ok: 1; }</style>'],
		['href="/styles.css', '<main>'],
	)
	// CSS needing HTML escaping must fall back to the <link> (the stream
	// renderer escapes text children, which would corrupt selectors).
	const unsafeHtml = await renderWithCss('.card > p { color: red; }')
	expect(unsafeHtml).toContain('href="/styles.css')
	expect(unsafeHtml).not.toContain('.card &gt; p')
})

test('signup social buttons are icon-only with accessible names', async () => {
	const labels = ['GitHub', 'Google', 'X', 'Discord']
	const { response, html } = await render(setupEnv(), '/signup', {
		loaderData: {
			authProviders: {
				ok: true,
				turnstileSiteKey: null,
				providers: labels.map((label) => ({ id: label.toLowerCase(), label })),
			},
		},
	})
	expect(response.status).toBe(200)
	expectHtml(
		html,
		labels.map((label) => `aria-label="Continue with ${label}"`),
	)
})

test('renderAppPage configures session secret and server-renders oauth authorize', async () => {
	const env = setupEnv([accountUser()])
	resetAuthSessionSecretForTests()
	const authorizePath =
		'/oauth/authorize?response_type=code&client_id=client-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=profile'
	const oauthAuthorize = (emailVerified: boolean | null) => ({
		ok: true as const,
		client: { id: 'client-1', name: 'Cursor' },
		scopes: ['profile', 'email'],
		emailVerified,
		requireCredentials: false,
	})

	const anonymous = await render(env, authorizePath, {
		cookie: 'kody_session=stale-or-unsigned; other=1',
		loaderData: { oauthAuthorize: oauthAuthorize(null) },
	})
	expect(anonymous.response.status).toBe(200)
	expectHtml(
		anonymous.html,
		[
			'data-testid="oauth-authorize-grant"',
			'data-testid="oauth-authorize-oidc-scopes"',
			'<code>profile</code>',
			'<code>email</code>',
			'data-testid="oauth-authorize-form"',
			'method="post"',
			'action="/oauth/authorize?response_type=code&amp;client_id=client-1',
			'name="decision"',
			'value="approve"',
			'aria-busy="true"',
		],
		[
			'OAuth authorization failed',
			'href="/images/hero/kody-base.webp"',
			'Unknown client',
			'Loading authorization details',
		],
	)
	expect(anonymous.html).toMatch(
		/data-testid="oauth-authorize-approve"[^>]*disabled/,
	)

	setAuthSessionSecret(testCookieSecret)
	const signedIn = await render(env, authorizePath, {
		cookie: await cookieFor(),
		loaderData: { oauthAuthorize: oauthAuthorize(false) },
	})
	expect(signedIn.response.status).toBe(200)
	expectHtml(
		signedIn.html,
		['aria-label="Email verification status"'],
		['Approve connection'],
	)
	expect(signedIn.html).toMatch(
		/data-testid="oauth-authorize-email-verify-deny"[^>]*disabled/,
	)
})

test('renderAppPage server-renders connect-oauth provider visits without a loading flash', async () => {
	const env = setupEnv()
	const redirectUri = 'https://example.com/connect/oauth'
	const googleIntegration = {
		name: 'google',
		appSlug: 'google',
		provider: 'google',
		appLabel: 'Google',
		accountLabel: null,
		tokenUrl: 'https://oauth2.googleapis.com/token',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'confidential' as const,
		usePkce: false,
		clientId: 'google-client-id-value',
		hasClientSecret: true,
		requiredHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: ['openid', 'email', 'profile'],
			scopeSeparator: null,
			extraAuthorizeParams: { access_type: 'offline' },
		},
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
	const renderConnect = async (
		path: string,
		connectOauth: Omit<ConnectOauthLoaderData, 'ok' | 'redirectUri'>,
	) => {
		const page = await render(env, `/connect/oauth${path}`, {
			loaderData: { connectOauth: { ok: true, redirectUri, ...connectOauth } },
		})
		expect(page.response.status).toBe(200)
		return page.html
	}
	const noIntegration = {
		integration: null,
		builtInAvailable: false,
		hasStoredClientSecret: false,
	}

	// A stored user-lane confidential google connection whose client secret
	// already exists: the page must SSR straight into "ready to connect"
	// with the Redirect URI card, not "Loading provider configuration…".
	expectHtml(
		await renderConnect('?provider=google', {
			provider: 'google',
			integration: googleIntegration,
			builtInAvailable: false,
			hasStoredClientSecret: true,
		}),
		[
			'data-testid="provider-mark"',
			'data-testid="connect-oauth-advanced"',
			'data-testid="connect-oauth-scopes"',
			'https://accounts.google.com/o/oauth2/v2/auth',
		],
	)

	// Reconnecting a platform connection is bring-your-own setup: the page
	// asks for the user's client credentials instead of one-click authorize.
	expectHtml(
		await renderConnect('?provider=google', {
			provider: 'google',
			integration: {
				...googleIntegration,
				usePkce: true,
				clientId: '',
				hasClientSecret: false,
				requiredHosts: ['oauth2.googleapis.com'],
				authorization: {
					...googleIntegration.authorization,
					scopes: ['openid'],
					extraAuthorizeParams: {},
				},
			},
			builtInAvailable: false,
			existingConnection: { lane: 'platform', appSlug: 'google' },
			hasStoredClientSecret: false,
		}),
		['Paste the client ID', redirectUri],
	)

	// First-time bring-your-own setup: credentials form and redirect URL are
	// visible; endpoints and allowed hosts stay behind the disclosure.
	expectHtml(
		await renderConnect(
			'?provider=github&authorizeUrl=https%3A%2F%2Fgithub.com%2Flogin%2Foauth%2Fauthorize&tokenUrl=https%3A%2F%2Fgithub.com%2Flogin%2Foauth%2Faccess_token',
			{ provider: 'github', ...noIntegration },
		),
		[
			redirectUri,
			'data-testid="connect-oauth-advanced"',
			'https://github.com/login/oauth/authorize',
		],
	)

	// Provider without stored or query endpoints: the missing-config error
	// is a single alert, not also repeated as the header description.
	const missingHtml = await renderConnect('?provider=unknown-provider', {
		provider: 'unknown-provider',
		...noIntegration,
	})
	expectHtml(missingHtml, [
		'role="alert"',
		'data-testid="connect-oauth-incomplete"',
	])
	expect(
		missingHtml.split('Missing required OAuth configuration parameters.')
			.length - 1,
	).toBe(1)

	// The chooser only adds a filter once it lists more than six options.
	const chooserOptions = [
		'google',
		'github',
		'slack',
		'discord',
		'notion',
		'spotify',
		'linear',
	].map((slug) => ({
		id: `connection:${slug}`,
		href: `/connect/oauth?provider=${slug}&app=${slug}`,
		label: slug,
		detail: 'Reconnect your OAuth app',
		providerKey: slug,
		logoPath: null,
		autoLogoPath: null,
		catalogLogoPath: null,
		kind: 'connection' as const,
	}))
	const renderChooser = (options: typeof chooserOptions, path = '') =>
		renderConnect(path, {
			provider: null,
			integration: null,
			chooser: { options },
		})
	const list = 'data-testid="connect-oauth-chooser-list"'
	const filter = 'data-testid="connect-oauth-chooser-filter"'
	expectHtml(
		await renderChooser(chooserOptions.slice(0, 1)),
		[
			'data-testid="connect-oauth-chooser"',
			list,
			'/connect/oauth?provider=google&app=google',
		],
		[filter],
	)
	expectHtml(await renderChooser(chooserOptions.slice(0, 6)), [list], [filter])
	expectHtml(await renderChooser(chooserOptions), [
		filter,
		list,
		'/connect/oauth?provider=linear&app=linear',
	])

	expectHtml(
		await renderChooser([], '?code=auth-code&state=abc'),
		['data-testid="connect-oauth-callback"'],
		['data-testid="connect-oauth-chooser"'],
	)
})

test('renderAppPage server-renders simplified integration and secret-approval pages', async () => {
	const env = setupEnv([accountUser()])
	const cookie = await cookieFor()
	const googleConnection = {
		name: 'google',
		appSlug: 'google',
		provider: 'google',
		appLabel: 'Google',
		accountLabel: 'me@example.com',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'confidential' as const,
		usePkce: false,
		clientId: 'google-client-id-value',
		hasClientSecret: true,
		requiredHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: ['openid', 'email', 'profile'],
			scopeSeparator: null,
			extraAuthorizeParams: { access_type: 'offline' },
		},
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
	const googleApp = {
		slug: 'google',
		provider: 'google',
		label: 'Google',
		clientId: 'google-client-id-value',
		hasClientSecret: true,
		tokenUrl: 'https://oauth2.googleapis.com/token',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'confidential' as const,
		usePkce: false,
		tokenExchangeStyle: null,
		scopeSeparator: null,
		extraAuthorizeParams: {},
		connectionCount: 1,
		connections: [{ name: 'google', accountLabel: 'me@example.com' }],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
	const renderIntegrations = async (
		path: string,
		integrations: Array<AccountIntegrationListItem> = [googleConnection],
		apps: Array<AccountOauthAppListItem> = [googleApp],
	) => {
		const page = await render(env, `/account/integrations${path}`, {
			cookie,
			loaderData: {
				accountIntegrations: {
					ok: true,
					email: 'user@example.com',
					username: 'account-user',
					integrations,
					apps,
				},
			},
		})
		expect(page.response.status).toBe(200)
		return page.html
	}

	const connectionHtml = await renderIntegrations('/google')
	expectHtml(
		connectionHtml,
		[
			'1 account connected.',
			'data-testid="add-account-open"',
			'href="/account/integrations/google?add-account=1#add-account"',
			'data-prevent-scroll-reset',
			'>Reconnect<',
			'data-testid="provider-mark"',
			'data-testid="integration-advanced"',
			'data-testid="integration-connection"',
			'data-highlighted="true"',
			'aria-label="Integrations"',
		],
		['data-testid="add-account-form"'],
	)

	expectHtml(
		await renderIntegrations('/apps/google'),
		[
			'1 account connected.',
			'data-testid="integration-advanced"',
			'Rotate credentials',
		],
		['data-highlighted="true"', 'data-testid="built-in-indicator"'],
	)

	const builtInConnection = { ...googleConnection, platform: true }
	const builtInHtml = await renderIntegrations(
		'/google',
		[
			builtInConnection,
			{
				...builtInConnection,
				name: 'google-work',
				accountLabel: 'work@example.com',
				authorization: null,
			},
		],
		[
			{
				...googleApp,
				platform: true,
				hasClientSecret: false,
				connectionCount: 2,
				connections: [
					{ name: 'google', accountLabel: 'me@example.com' },
					{ name: 'google-work', accountLabel: 'work@example.com' },
				],
			},
		],
	)
	expectHtml(
		builtInHtml,
		[
			'data-testid="built-in-indicator"',
			'2 accounts connected.',
			'data-testid="add-account-open"',
			'Needs setup',
			'>Connect<',
			'/connect/oauth?provider=google-work',
		],
		['data-testid="add-account-form"', 'Rotate credentials'],
	)

	expectHtml(
		await renderIntegrations('/google?add-account=1#add-account'),
		['data-testid="add-account-form"', 'id="add-account"', 'value="google-2"'],
		['data-testid="add-account-open"'],
	)
	expect(await renderIntegrations('/missing-connection')).toContain(
		'data-testid="connection-not-found"',
	)
	expect(await renderIntegrations('/apps/missing-app')).toContain(
		'data-testid="integration-not-found"',
	)
	expect(await renderIntegrations('', [], [])).toContain('No integrations yet.')

	const secret = {
		id: 'user:googleAccessToken',
		name: 'googleAccessToken',
		scope: 'user' as const,
		description: '',
		packageId: null,
		packageTitle: null,
		allowedHosts: ['oauth2.googleapis.com'],
		allowedPackages: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		expiresAt: null,
		ttlMs: null,
	}
	const approval = await render(
		env,
		'/account/secrets/user/googleAccessToken?allowed-host=gmail.googleapis.com',
		{
			cookie,
			loaderData: {
				accountSecrets: {
					ok: true,
					email: 'user@example.com',
					packageOptions: [],
					packages: [],
					secrets: [secret],
					selectedSecret: { ...secret, value: 'redacted' },
					approval: {
						name: 'googleAccessToken',
						names: ['googleAccessToken'],
						scope: 'user',
						requestedHost: 'gmail.googleapis.com',
						requestedHosts: ['gmail.googleapis.com'],
						rejectedHosts: [],
						requestedPackageId: null,
						currentAllowedHosts: ['oauth2.googleapis.com'],
						currentAllowedPackages: [],
					},
					approvalError: null,
				},
			},
		},
	)
	expect(approval.response.status).toBe(200)
	expectHtml(approval.html, [
		'Allow access',
		'gmail.googleapis.com',
		'data-testid="secret-approval-advanced"',
	])
})

test('renderAppPage renders the blog index and posts with placeholder or reviewed artwork', async () => {
	const env = setupEnv()
	const posts = listBlogPosts().map(toBlogPostSummary)
	expect(posts.length).toBeGreaterThan(0)
	const index = await render(env, '/blog', {
		loaderData: { blog: { ok: true, posts } },
	})
	expect(index.response.status).toBe(200)
	expectHtml(
		index.html,
		posts.map((post) => `href="/blog/${post.slug}"`),
	)

	const renderPost = async (slug: string) => {
		const post = listBlogPosts().find((candidate) => candidate.slug === slug)
		if (!post) throw new Error(`Missing blog post ${slug}`)
		const readNext = getReadNextBlogPost(slug)
		const page = await render(env, `/blog/${slug}`, {
			loaderData: {
				blogPost: {
					ok: true,
					slug,
					title: post.title,
					date: post.date,
					description: post.description,
					placeholder: post.placeholder,
					image: post.image,
					imageAlt: post.imageAlt,
					ogImage: post.ogImage,
					body: post.body,
					readNext,
				},
			},
		})
		expect(page.response.status).toBe(200)
		return { post, readNext, html: page.html }
	}

	// A real catalog post whose own title and read-next title carry no
	// apostrophes (JSX escaping would rewrite them in the HTML output).
	// Markdown body renders in the prose voice: authored `##` stays h2 (not
	// the README demotion to h4).
	const placeholder = await renderPost('every-install-is-a-fork-you-own')
	expect(placeholder.readNext).not.toBeNull()
	expectHtml(placeholder.html, [
		'href="/blog"',
		`href="/blog/${placeholder.readNext!.slug}"`,
		BLOG_PLACEHOLDER_CALLOUT,
	])
	expect(placeholder.html).toMatch(/<h2[^>]*>/)
	expect(placeholder.html).not.toMatch(/<h4[^>]*>/)

	const reviewed = await renderPost('kody-vs-executor')
	expect(reviewed.post.placeholder).toBe(false)
	expect(reviewed.post.image).toBe('/images/kody-vs-executor.webp')
	expect(reviewed.post.ogImage).toBe('/images/kody-vs-executor-og.jpg')
	expectHtml(
		reviewed.html,
		[
			'src="/images/kody-vs-executor.webp"',
			'property="og:image" content="https://example.com/blog/kody-vs-executor/og.png"',
		],
		[BLOG_PLACEHOLDER_CALLOUT],
	)
})

function mockPublicListing(listing: CommunityListingWithAggregates) {
	communityMockModule.getCommunityListingWithAggregates.mockResolvedValue(
		listing,
	)
	communityMockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'public',
		stable_user_id: 'owner-mcp-id',
	})
}

function runPackagePage(
	env: Env,
	username: string,
	kodyId: string,
	cookie?: string,
) {
	return runHtml(
		createCommunityPackageHandler(env),
		get(`/@${username}/${kodyId}`, cookie),
		{ username, kodyId },
	)
}

test('canonical package URL SSR renders the redesigned article', async () => {
	const env = setupEnv()
	mockPublicListing({
		...sampleListing,
		id: 'listing-detail-1',
		trusted: true,
		trustedCommit: 'abc1234567890',
		trustedAt: '2026-01-02T00:00:00.000Z',
		readmeContent:
			'# @kentcdodds/github-triage\n\n## Intent\n\nTriage GitHub issues for me.\n\n## Exports\n\n- `./triage` — run the triage pass.',
	})
	communityMockModule.resolveCommunityListingRoute.mockResolvedValue({
		kind: 'listing',
		listingId: 'listing-detail-1',
	})
	communityMockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'kentcdodds',
		kodyId: 'github-triage',
		userId: 'owner-mcp-id',
		savedPackage: null,
		listingId: 'listing-detail-1',
	})

	const { response, html } = await runPackagePage(
		env,
		'kentcdodds',
		'github-triage',
	)
	expect(response.status).toBe(200)
	expectHtml(html, [
		'data-testid="community-detail-frame"',
		'data-testid="community-listing-icon-detail"',
		'/community/listing-detail-1/icon/abc1234567890',
		'data-testid="community-readme"',
		'data-testid="community-detail-install"',
	])
	expect(readAppRootProps(html).loaderData?.communityDetailShell).toMatchObject(
		{
			ok: true,
			listingId: 'listing-detail-1',
			name: '@kentcdodds/github-triage',
			trusted: false,
		},
	)
})

test('listing-uuid URLs redirect to the canonical pair when possible and keep serving otherwise', async () => {
	const env = setupEnv()
	mockPublicListing({ ...sampleListing, id: 'listing-detail-1' })
	const runDetail = (path: string) =>
		runHtml(createCommunityDetailHandler(env), get(path), {
			listingId: 'listing-detail-1',
		})

	// Query strings ride the hop so a shared or bookmarked listing-uuid URL
	// does not drop its extra params on the way to the canonical pair.
	communityMockModule.resolveCanonicalListingPath.mockResolvedValue(
		'/@kentcdodds/github-triage',
	)
	const redirect = await runDetail('/community/listing-detail-1?source=share')
	expect(redirect.response.status).toBe(301)
	expect(redirect.response.headers.get('location')).toBe(
		'https://example.com/@kentcdodds/github-triage?source=share',
	)
	// The same URL serves frame HTML, which must not get this redirect back.
	expect(redirect.response.headers.get('vary')).toBe('x-remix-target')

	// A stale owner scope in the listing name: redirecting would cache a 404.
	communityMockModule.resolveCanonicalListingPath.mockResolvedValue(null)
	const fallback = await runDetail('/community/listing-detail-1')
	expect(fallback.response.status).toBe(200)
	expect(
		readAppRootProps(fallback.html).loaderData?.communityDetailShell,
	).toMatchObject({ ok: true, listingId: 'listing-detail-1' })
})

test('unlisted package rename redirects stay owner-only and uncached', async () => {
	const owner = makeUser('owner@example.com', 'owner')
	const env = setupEnv([owner])
	communityMockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'redirect',
		username: 'owner',
		kodyId: 'renamed',
		userId: owner.stable_user_id,
		listingId: null,
	})

	const anonymous = await runPackagePage(env, 'owner', 'old-notes')
	expect(anonymous.response.status).toBe(404)

	const { response } = await runPackagePage(
		env,
		'owner',
		'old-notes',
		await cookieFor(owner.email),
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('location')).toBe(
		'https://example.com/@owner/renamed',
	)
	expect(response.headers.get('cache-control')).toBe('private, no-store')
	expect(response.headers.get('vary')).toBe('x-remix-target, Cookie')
})

test('listed package rename does not 301 anonymous visitors to the unpublished id', async () => {
	const env = setupEnv()
	mockPublicListing({
		...sampleListing,
		id: 'listing-detail-1',
		kodyId: 'github-triage',
	})
	const listingTarget = {
		username: 'kentcdodds',
		kodyId: 'github-triage',
		userId: 'owner-mcp-id',
		listingId: 'listing-detail-1',
		listingKodyId: 'github-triage',
	}
	communityMockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		...listingTarget,
		savedPackage: {
			id: 'pkg-1',
			kodyId: 'github-triage-two',
			hidden: false,
			isPrivate: false,
		},
	})
	const listingUrl = await runPackagePage(env, 'kentcdodds', 'github-triage')
	expect(listingUrl.response.status).toBe(200)
	expect(listingUrl.response.headers.get('location')).toBeNull()

	communityMockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'redirect',
		...listingTarget,
	})
	const caseCorrect = await runPackagePage(env, 'KentCDodds', 'GITHUB-TRIAGE')
	expect(caseCorrect.response.status).toBe(301)
	expect(caseCorrect.response.headers.get('location')).toBe(
		'https://example.com/@kentcdodds/github-triage',
	)
})
