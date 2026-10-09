import { expect, test, vi } from 'vitest'
import {
	documentHasPersistentShell,
	isSameShellAreaNavigation,
	matchRoute,
	matchRouteLoader,
	navigate,
	navigationTimeoutMs,
	persistentShellNavSelector,
	prefetchRouteHrefs,
	registerClientRoutes,
	registerRouteLoaders,
	Router,
	shouldLeaveDocumentForPath,
	shouldRouterHandleClick,
	shouldUseViewTransition,
	type RouteLoader,
} from './client-router.tsx'
import {
	abortIntentPrefetch,
	takePrefetchedRouteResult,
} from './intent-prefetch.ts'
import { communityArea } from './lazy-route.tsx'
import { routePattern } from '#universal/route-pattern.ts'
import { routes } from '#universal/routes.ts'

const element = (name: string) => name as unknown as JSX.Element

function stubWindow(pathname: string, extra: { assign?: () => void } = {}) {
	const previousWindow = globalThis.window
	globalThis.window = {
		location: {
			href: `https://kody.local${pathname}`,
			origin: 'https://kody.local',
			pathname,
			search: '',
			hash: '',
			...extra,
		},
	} as unknown as Window & typeof globalThis
	return {
		[Symbol.dispose]: () => {
			globalThis.window = previousWindow
		},
	}
}

const click = {
	defaultPrevented: false,
	button: 0,
	metaKey: false,
	altKey: false,
	ctrlKey: false,
	shiftKey: false,
} as MouseEvent

const anchor = (href: string, attribute?: string) =>
	({
		target: '',
		hasAttribute: (name: string) => name === attribute,
		getAttribute: (name: string) => (name === 'href' ? href : null),
	}) as unknown as HTMLAnchorElement

test('client route and loader matching prefer specific static routes over dynamic parents', () => {
	const pageRoutes = {
		'/account/mcp-servers/:serverId': element('server-detail'),
		'/account/mcp-servers/new': element('new-server'),
		'/account/secrets/:secretId': element('generic-secret'),
		'/account/secrets/user/:secretName': element('user-secret'),
		[routePattern(routes.communityPackage)]: element('package-detail'),
		[routePattern(routes.communityPackageApprovePublish)]:
			element('approve-publish'),
	}
	const routeCases: Array<[string, string]> = [
		['/account/mcp-servers/new', 'new-server'],
		['/account/mcp-servers/server-1', 'server-detail'],
		['/account/secrets/user/github-token', 'user-secret'],
		['/account/secrets/secret-1', 'generic-secret'],
		['/@kentcdodds/pkg-1', 'package-detail'],
		['/@kentcdodds/pkg-1/approve-publish', 'approve-publish'],
		['/@kentcdodds/pkg-1/approve-publish?commit=abc1234', 'approve-publish'],
	]
	expect(
		routeCases.map(([path]) => [path, matchRoute(path, pageRoutes)]),
	).toEqual(routeCases)

	const loader = (key: string) =>
		(async () => ({ [key]: { ok: true } })) as RouteLoader
	const accountLoader = loader('accountProfile')
	const serverLoader = loader('accountMcpServers')
	const genericSecretLoader = loader('accountSecrets')
	const userSecretLoader = loader('accountSecrets')
	const loaders = {
		'/account/mcp-servers/:serverId': serverLoader,
		'/account/mcp-servers/new': serverLoader,
		'/account': accountLoader,
		'/account/secrets/:secretId': genericSecretLoader,
		'/account/secrets/user/:secretName': userSecretLoader,
	}
	expect(matchRouteLoader('/account', loaders)).toBe(accountLoader)
	expect(matchRouteLoader('/account/mcp-servers/new', loaders)).toBe(
		serverLoader,
	)
	expect(matchRouteLoader('/account/mcp-servers/server-1', loaders)).toBe(
		serverLoader,
	)
	expect(matchRouteLoader('/account/secrets/user/github-token', loaders)).toBe(
		userSecretLoader,
	)
	expect(matchRouteLoader('/account/secrets/secret-1', loaders)).toBe(
		genericSecretLoader,
	)
})

test('view transitions skip shell tab switches, including when from-path was never recorded', () => {
	// Tab switching inside a persistent shell (account/admin rail, docs
	// sidebar): the chrome is unchanged and full-height, so a snapshot
	// transition would squash or fade it. These swap instantly.
	const sameShell: Array<[string | null, string, boolean]> = [
		['/account', '/account/secrets', true],
		['/account/jobs?view=failed', '/account/values', true],
		['/admin/users', '/admin/feature-flags', true],
		['/docs', '/docs/oauth', true],
		['/docs/oauth', '/docs/connect', true],
		['/docs/how-kody-works', '/docs', true],
		['/pricing', '/account', false],
		['/account', '/pricing', false],
		['/account', '/admin/users', false],
		['/docs', '/pricing', false],
		['/docs', '/documentation', false],
		[null, '/account', false],
		['/account', '/accounts-payable', false],
	]
	expect(
		sameShell.filter(
			([from, to, want]) => isSameShellAreaNavigation(from, to) !== want,
		),
	).toEqual([])

	// [from, to, animates, hasPersistentShell]
	const transitions: Array<[string | null, string, boolean, boolean?]> = [
		// The production bug: first click after a full load had from=null, so the
		// path-only skip missed and the whole account shell faded + slid 8px.
		[null, '/account/activity', false, true],
		['/account/usage', '/account/activity', false, true],
		['/account/usage', '/account/activity', false],
		['/docs', '/docs/oauth', false],
		['/docs/oauth', '/docs/connect', false],
		[null, '/docs/how-kody-works', false, true],
		['/pricing', '/docs', true],
		['/docs/oauth', '/blog', true],
		// Leaving, entering, or crossing shells is still a real page change.
		['/account/usage', '/pricing', true, true],
		['/account/usage', '/admin/users', true, true],
		['/pricing', '/account/usage', true],
		[null, '/account/usage', true],
		// Same pathname+search (hash-only / same-URL refresh) never animates.
		['/account/usage', '/account/usage', false],
		// Onboarding subroutes share heading, stepper, and picker chrome. A
		// page view-transition would fade those in place; only the incoming
		// panel may move.
		['/onboarding/step-1', '/onboarding/step-1/cursor', false],
		['/onboarding/step-1/cursor', '/onboarding/step-1/not-listed', false],
		['/onboarding/step-2', '/onboarding/step-2/notion', false],
		[null, '/onboarding/step-1/cursor', false],
		['/pricing', '/onboarding/step-1', true],
		['/onboarding/step-1', '/pricing', true],
		// Chip filters and search on `/@username` stay on the same page.
		['/@jane', '/@jane?app=yes', false],
		['/@jane?visibility=private', '/@jane?app=no', false],
		['/@jane', '/@jane?q=notes', false],
		['/@jane', '/@jane?package=no', false],
		['/@jane', '/@jane?sort=created', false],
		['/@jane', '/@jane?dir=asc', false],
		['/@jane', '/@other', true],
		['/pricing', '/@jane', true],
		// Repo / Files / Settings share chrome; crossing packages still animates.
		['/@kentcdodds/grok-bot', '/@kentcdodds/grok-bot/tree/main', false],
		[
			'/@kentcdodds/grok-bot/tree/main',
			'/@kentcdodds/grok-bot/settings',
			false,
		],
		['/@kentcdodds/grok-bot/settings', '/@kentcdodds/grok-bot', false],
		['/@kentcdodds/grok-bot', '/@kentcdodds/other-bot', true],
	]
	expect(
		transitions.filter(
			([from, to, want, hasPersistentShell]) =>
				shouldUseViewTransition({
					from,
					to,
					canStart: true,
					prefersReducedMotion: false,
					hasPersistentShell,
				}) !== want,
		),
	).toEqual([])

	const withRail = {
		querySelector: (selector: string) =>
			selector === persistentShellNavSelector ? ({} as Element) : null,
	}
	expect(documentHasPersistentShell(withRail)).toBe(true)
	expect(documentHasPersistentShell({ querySelector: () => null })).toBe(false)
	expect(documentHasPersistentShell(null)).toBe(false)
})

test('same-origin hash links are intercepted so scroll restoration can reach them', () => {
	using _window = stubWindow('/')
	expect(shouldRouterHandleClick(click, anchor('#invite'))).toBe(true)
	expect(shouldRouterHandleClick(click, anchor('/#invite'))).toBe(true)
	expect(
		shouldRouterHandleClick(click, anchor('https://example.com/#invite')),
	).toBe(false)
	expect(
		shouldRouterHandleClick(click, anchor('/community', 'data-rmx-target')),
	).toBe(false)
})

test('doc and blog markdown twins leave the SPA instead of rendering a 404', () => {
	const guidePage = element('guide-page')
	const pageRoutes = {
		[routePattern(routes.docDetail)]: guidePage,
		[routePattern(routes.blogPost)]: element('blog-page'),
		[routePattern(routes.docs)]: guidePage,
		[routePattern(routes.home)]: guidePage,
	}

	expect(matchRoute('/docs/oauth', pageRoutes)).toBe(guidePage)
	for (const path of [
		'/docs/oauth.md',
		'/docs/oauth.json',
		'/docs/llms.txt',
		'/blog/your-assistants-home.md',
		routes.blogRss.href(),
	]) {
		expect(matchRoute(path, pageRoutes)).toBeNull()
	}
	expect(routes.docDetailMarkdown.href({ slug: 'oauth' })).toBe(
		'/docs/oauth.md',
	)
	expect(routes.blogRss.href()).toBe('/blog/rss.xml')

	registerClientRoutes(pageRoutes)
	const assign = vi.fn<() => void>()
	using _window = stubWindow('/docs/oauth', { assign })
	try {
		const leaves: Array<[string, boolean]> = [
			['/docs', false],
			['/docs/oauth', false],
			['/docs/connect', false],
			['/docs/oauth.md', true],
			['/docs.md', true],
			['/docs/connect.md', true],
			['/docs/llms.txt', true],
			// Legacy URLs are worker 308s, never SPA pages.
			['/guides/oauth', true],
			['/auth.md', true],
			['/robots.txt', true],
			['/missing-page', true],
			[routes.blogRss.href(), true],
		]
		expect(
			leaves.filter(
				([path, want]) => shouldLeaveDocumentForPath(path) !== want,
			),
		).toEqual([])

		expect(shouldRouterHandleClick(click, anchor('/docs/oauth.md'))).toBe(false)
		expect(
			shouldRouterHandleClick(
				click,
				anchor('/docs/oauth.md', 'data-rmx-document'),
			),
		).toBe(false)
		expect(
			shouldRouterHandleClick(
				click,
				anchor(routes.blogRss.href(), 'data-rmx-document'),
			),
		).toBe(false)
		expect(shouldRouterHandleClick(click, anchor('/docs/oauth'))).toBe(true)

		navigate('/docs/how-kody-works.md')
		expect(assign).toHaveBeenCalledWith('/docs/how-kody-works.md')
		navigate(routes.blogRss.href())
		expect(assign).toHaveBeenCalledWith(routes.blogRss.href())
	} finally {
		registerClientRoutes({})
	}
})

test('the router holds the previous route until a cold destination module is cached', async () => {
	let url = '/pricing'
	const pricingRoute = element('pricing-route')
	const communityRoute = element('community-route')
	const render = Router({
		props: {
			routes: { '/pricing': pricingRoute, '/community': communityRoute },
		},
		signal: new AbortController().signal,
		update: vi.fn(),
		context: { get: () => ({ url, ssrUrl: '/pricing' }) },
	} as never)

	expect(render()).toBe(pricingRoute)
	url = '/community'
	expect(render()).toBe(pricingRoute)

	await communityArea.load()
	expect(render()).toBe(communityRoute)
})

test('a navigation that exceeds the timeout falls back to a full document navigation', async () => {
	vi.useFakeTimers()
	const assign = vi.fn()
	using _window = stubWindow('/', { assign })
	registerRouteLoaders({ '/stuck': () => new Promise(() => {}) })

	try {
		navigate('/stuck')
		await vi.advanceTimersByTimeAsync(navigationTimeoutMs)

		expect(assign).toHaveBeenCalledWith('/stuck')
	} finally {
		registerRouteLoaders({})
		vi.clearAllTimers()
		vi.useRealTimers()
	}
})

test('prefetchRouteHrefs warms every registered destination so click skips a cold loader', async () => {
	abortIntentPrefetch()
	using _window = stubWindow('/onboarding/step-2')

	const calls: Array<string> = []
	const payload = { onboarding: { ok: true } as never }
	const loader: RouteLoader = async (url) => {
		calls.push(`${url.pathname}${url.search}`)
		return payload
	}
	registerRouteLoaders({
		[routePattern(routes.onboardingStep2Service)]: loader,
		[routePattern(routes.onboardingStep1Agent)]: loader,
	})

	try {
		prefetchRouteHrefs([
			'/onboarding/step-2',
			'/onboarding/step-2/notion',
			'/onboarding/step-2/linear',
			'/onboarding/step-1/cursor',
			'/community',
		])
		expect(calls).toEqual(['/onboarding/step-2/notion'])
		await Promise.resolve()

		const notion = takePrefetchedRouteResult('/onboarding/step-2/notion')
		expect(notion).not.toBeNull()
		await expect(notion).resolves.toEqual(payload)
		expect(
			takePrefetchedRouteResult('/onboarding/step-2/linear'),
		).not.toBeNull()
		expect(
			takePrefetchedRouteResult('/onboarding/step-1/cursor'),
		).not.toBeNull()
		expect(takePrefetchedRouteResult('/community')).toBeNull()
		expect(calls).toHaveLength(1)
	} finally {
		abortIntentPrefetch()
		registerRouteLoaders({})
	}
})

test('prefetchRouteHrefs independent warms each docs slug with its own request', async () => {
	abortIntentPrefetch()
	using _window = stubWindow('/docs/memory')

	const calls: Array<string> = []
	const loader: RouteLoader = async (url) => {
		const href = `${url.pathname}${url.search}`
		calls.push(href)
		return { docDetail: { ok: true, slug: href } as never }
	}
	registerRouteLoaders({
		[routePattern(routes.docDetail)]: loader,
		[routePattern(routes.docsConnect)]: loader,
		[routePattern(routes.docs)]: loader,
	})

	try {
		prefetchRouteHrefs(
			['/docs/oauth', '/docs/memory', '/docs/secrets', '/docs/connect'],
			{ independent: true },
		)
		expect(calls).toEqual(['/docs/oauth', '/docs/secrets', '/docs/connect'])
		await Promise.resolve()

		const oauth = takePrefetchedRouteResult('/docs/oauth')
		expect(oauth).not.toBeNull()
		await expect(oauth).resolves.toEqual({
			docDetail: { ok: true, slug: '/docs/oauth' },
		})
		expect(takePrefetchedRouteResult('/docs/oauth')).toBeNull()

		const secrets = takePrefetchedRouteResult('/docs/secrets')
		expect(secrets).not.toBeNull()
		await expect(secrets).resolves.toEqual({
			docDetail: { ok: true, slug: '/docs/secrets' },
		})
		expect(takePrefetchedRouteResult('/docs/connect')).not.toBeNull()
		expect(takePrefetchedRouteResult('/docs/memory')).toBeNull()
		expect(calls).toHaveLength(3)
	} finally {
		abortIntentPrefetch()
		registerRouteLoaders({})
	}
})
