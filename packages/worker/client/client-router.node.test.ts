import { expect, test, vi } from 'vitest'
import {
	documentHasPersistentShell,
	isSameShellAreaNavigation,
	matchRoute,
	matchRouteLoader,
	navigate,
	navigationTimeoutMs,
	persistentShellNavSelector,
	registerRouteLoaders,
	Router,
	shouldRouterHandleClick,
	shouldUseViewTransition,
	type RouteLoader,
} from './client-router.tsx'
import { communityArea } from './lazy-route.tsx'

test('client route and loader matching prefer specific static routes over dynamic parents', () => {
	const tokenDetailRoute = 'token-detail-route' as unknown as JSX.Element
	const newTokenRoute = 'new-token-route' as unknown as JSX.Element
	const routes = {
		'/account/package-invocation-tokens/:tokenId': tokenDetailRoute,
		'/account/package-invocation-tokens/new': newTokenRoute,
	}

	expect(matchRoute('/account/package-invocation-tokens/new', routes)).toBe(
		newTokenRoute,
	)
	expect(matchRoute('/account/package-invocation-tokens/token-1', routes)).toBe(
		tokenDetailRoute,
	)

	const genericSecretRoute = 'generic-secret-route' as unknown as JSX.Element
	const userSecretRoute = 'user-secret-route' as unknown as JSX.Element
	const nestedRoutes = {
		'/account/secrets/:secretId': genericSecretRoute,
		'/account/secrets/user/:secretName': userSecretRoute,
	}

	expect(matchRoute('/account/secrets/user/github-token', nestedRoutes)).toBe(
		userSecretRoute,
	)
	expect(matchRoute('/account/secrets/secret-1', nestedRoutes)).toBe(
		genericSecretRoute,
	)

	const accountLoader = (async () => ({
		accountProfile: { ok: true },
	})) as RouteLoader
	const tokenLoader = (async () => ({
		accountPackageInvocationTokens: { ok: true },
	})) as RouteLoader
	const loaders = {
		'/account/package-invocation-tokens/:tokenId': tokenLoader,
		'/account/package-invocation-tokens/new': tokenLoader,
		'/account': accountLoader,
	}

	expect(matchRouteLoader('/account', loaders)).toBe(accountLoader)
	expect(
		matchRouteLoader('/account/package-invocation-tokens/new', loaders),
	).toBe(tokenLoader)
	expect(
		matchRouteLoader('/account/package-invocation-tokens/token-1', loaders),
	).toBe(tokenLoader)

	const genericSecretLoader = (async () => ({
		accountSecrets: { ok: true },
	})) as RouteLoader
	const userSecretLoader = (async () => ({
		accountSecrets: { ok: true },
	})) as RouteLoader
	const secretLoaders = {
		'/account/secrets/:secretId': genericSecretLoader,
		'/account/secrets/user/:secretName': userSecretLoader,
	}

	expect(
		matchRouteLoader('/account/secrets/user/github-token', secretLoaders),
	).toBe(userSecretLoader)
	expect(matchRouteLoader('/account/secrets/secret-1', secretLoaders)).toBe(
		genericSecretLoader,
	)
})

test('view transitions are skipped only when a navigation stays inside one shell area', () => {
	// Tab switching inside the account/admin shell: the rail is unchanged and
	// full-height, so a snapshot transition would squash it between two page
	// heights. These swap instantly.
	expect(isSameShellAreaNavigation('/account', '/account/secrets')).toBe(true)
	expect(
		isSameShellAreaNavigation('/account/jobs?view=failed', '/account/values'),
	).toBe(true)
	expect(
		isSameShellAreaNavigation('/admin/users', '/admin/feature-flags'),
	).toBe(true)

	// Entering, leaving, or crossing between shells is a real page change.
	expect(isSameShellAreaNavigation('/pricing', '/account')).toBe(false)
	expect(isSameShellAreaNavigation('/account', '/pricing')).toBe(false)
	expect(isSameShellAreaNavigation('/account', '/admin/users')).toBe(false)
	expect(isSameShellAreaNavigation(null, '/account')).toBe(false)

	// A path that merely starts with the area's characters is a different area.
	expect(isSameShellAreaNavigation('/account', '/accounts-payable')).toBe(false)
})

test('view transitions stay off for shell tab switches even when from-path was never recorded', () => {
	const animate = (input: {
		from: string | null
		to: string
		hasPersistentShell?: boolean
	}) =>
		shouldUseViewTransition({
			from: input.from,
			to: input.to,
			canStart: true,
			prefersReducedMotion: false,
			hasPersistentShell: input.hasPersistentShell,
		})

	// The production bug: first click after a full load had from=null, so the
	// path-only skip missed and the whole account shell faded + slid 8px.
	expect(
		animate({
			from: null,
			to: '/account/activity',
			hasPersistentShell: true,
		}),
	).toBe(false)
	expect(
		animate({
			from: '/account/usage',
			to: '/account/activity',
			hasPersistentShell: true,
		}),
	).toBe(false)
	expect(animate({ from: '/account/usage', to: '/account/activity' })).toBe(
		false,
	)

	// Leaving, entering, or crossing shells is still a real page change.
	expect(
		animate({
			from: '/account/usage',
			to: '/pricing',
			hasPersistentShell: true,
		}),
	).toBe(true)
	expect(
		animate({
			from: '/account/usage',
			to: '/admin/users',
			hasPersistentShell: true,
		}),
	).toBe(true)
	expect(animate({ from: '/pricing', to: '/account/usage' })).toBe(true)
	expect(animate({ from: null, to: '/account/usage' })).toBe(true)

	// Same pathname+search (hash-only / same-URL refresh) never animates.
	expect(animate({ from: '/account/usage', to: '/account/usage' })).toBe(false)
	expect(
		shouldUseViewTransition({
			from: '/pricing',
			to: '/community',
			canStart: false,
			prefersReducedMotion: false,
		}),
	).toBe(false)
	expect(
		shouldUseViewTransition({
			from: '/pricing',
			to: '/community',
			canStart: true,
			prefersReducedMotion: true,
		}),
	).toBe(false)

	const withRail = {
		querySelector: (selector: string) =>
			selector === persistentShellNavSelector ? ({} as Element) : null,
	}
	const withoutRail = { querySelector: () => null }
	expect(documentHasPersistentShell(withRail)).toBe(true)
	expect(documentHasPersistentShell(withoutRail)).toBe(false)
	expect(documentHasPersistentShell(null)).toBe(false)
})

test('same-origin hash links are intercepted so scroll restoration can reach them', () => {
	const previousWindow = globalThis.window
	globalThis.window = {
		location: {
			href: 'https://kody.local/',
			origin: 'https://kody.local',
		},
	} as Window & typeof globalThis

	try {
		const click = {
			defaultPrevented: false,
			button: 0,
			metaKey: false,
			altKey: false,
			ctrlKey: false,
			shiftKey: false,
		} as MouseEvent
		const hashAnchor = {
			target: '',
			hasAttribute: () => false,
			getAttribute: (name: string) => (name === 'href' ? '#invite' : null),
		} as unknown as HTMLAnchorElement
		expect(shouldRouterHandleClick(click, hashAnchor)).toBe(true)

		const sameDocumentHashAnchor = {
			target: '',
			hasAttribute: () => false,
			getAttribute: (name: string) => (name === 'href' ? '/#invite' : null),
		} as unknown as HTMLAnchorElement
		expect(shouldRouterHandleClick(click, sameDocumentHashAnchor)).toBe(true)

		const externalAnchor = {
			target: '',
			hasAttribute: () => false,
			getAttribute: (name: string) =>
				name === 'href' ? 'https://example.com/#invite' : null,
		} as unknown as HTMLAnchorElement
		expect(shouldRouterHandleClick(click, externalAnchor)).toBe(false)

		const remixFrameAnchor = {
			target: '',
			hasAttribute: (name: string) => name === 'rmx-target',
			getAttribute: (name: string) => (name === 'href' ? '/community' : null),
		} as unknown as HTMLAnchorElement
		expect(shouldRouterHandleClick(click, remixFrameAnchor)).toBe(false)
	} finally {
		globalThis.window = previousWindow
	}
})

test('the router holds the previous route until a cold destination module is cached', async () => {
	let url = '/pricing'
	const pricingRoute = 'pricing-route' as unknown as JSX.Element
	const communityRoute = 'community-route' as unknown as JSX.Element
	const render = Router({
		props: {
			routes: {
				'/pricing': pricingRoute,
				'/community': communityRoute,
			},
		},
		signal: new AbortController().signal,
		update: vi.fn(),
		context: {
			get: () => ({ url, ssrUrl: '/pricing' }),
		},
	} as never)

	expect(render()).toBe(pricingRoute)
	url = '/community'
	expect(render()).toBe(pricingRoute)

	await communityArea.load()
	expect(render()).toBe(communityRoute)
})

test('a navigation that exceeds the timeout falls back to a full document navigation', async () => {
	vi.useFakeTimers()
	const previousWindow = globalThis.window
	const assign = vi.fn()
	globalThis.window = {
		location: {
			href: 'https://kody.local/',
			origin: 'https://kody.local',
			pathname: '/',
			search: '',
			hash: '',
			assign,
		},
	} as unknown as Window & typeof globalThis
	registerRouteLoaders({
		'/stuck': () => new Promise(() => {}),
	})

	try {
		navigate('/stuck')
		await vi.advanceTimersByTimeAsync(navigationTimeoutMs)

		expect(assign).toHaveBeenCalledWith('/stuck')
	} finally {
		registerRouteLoaders({})
		vi.clearAllTimers()
		vi.useRealTimers()
		globalThis.window = previousWindow
	}
})
