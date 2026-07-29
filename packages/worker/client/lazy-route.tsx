import { type Handle } from 'remix/ui'
import { createMultiMatcher } from 'remix/route-pattern/match'
import { oauthPaths } from '#app/oauth-paths.ts'
import { routePattern } from '#app/route-pattern.ts'
import { routes } from '#app/routes.ts'
import { type RouteLoader } from './route-loader.ts'
import type * as accountAreaExports from './routes/account-area.ts'
import type * as adminAreaExports from './routes/admin-area.ts'
import type * as blogAreaExports from './routes/blog-area.ts'
import type * as communityAreaExports from './routes/community-area.ts'
import type * as onboardingAreaExports from './routes/onboarding-area.ts'

export type LazyRouteArea<TModule> = {
	load: () => Promise<TModule>
	getCached: () => TModule | null
}

export function createLazyRouteArea<TModule>(
	loadModule: () => Promise<TModule>,
): LazyRouteArea<TModule> {
	let cached: TModule | null = null
	let pending: Promise<TModule> | null = null

	return {
		async load() {
			if (cached) return cached
			if (!pending) {
				pending = loadModule()
					.then((module) => {
						cached = module
						return module
					})
					.finally(() => {
						// Keep a rejected promise cached only until the next load()
						// call so a transient failure can be retried (e.g. after a
						// deploy rotates chunk hashes and a full reload is needed).
						if (!cached) pending = null
					})
			}
			return pending
		},
		getCached() {
			return cached
		},
	}
}

export type AccountAreaModule = typeof accountAreaExports
export type AdminAreaModule = typeof adminAreaExports
export type CommunityAreaModule = typeof communityAreaExports
export type BlogAreaModule = typeof blogAreaExports
export type OnboardingAreaModule = typeof onboardingAreaExports

export const accountArea = createLazyRouteArea<AccountAreaModule>(
	() =>
		// Dynamic import is intentional for route-level code splitting
		// (sanctioned exception to the no-inline-imports rule).
		import('./routes/account-area.ts'),
)

export const adminArea = createLazyRouteArea<AdminAreaModule>(
	() =>
		// Dynamic import is intentional for route-level code splitting
		// (sanctioned exception to the no-inline-imports rule).
		import('./routes/admin-area.ts'),
)

export const communityArea = createLazyRouteArea<CommunityAreaModule>(
	() =>
		// Dynamic import is intentional for route-level code splitting
		// (sanctioned exception to the no-inline-imports rule).
		import('./routes/community-area.ts'),
)

export const blogArea = createLazyRouteArea<BlogAreaModule>(
	() =>
		// Dynamic import is intentional for route-level code splitting
		// (sanctioned exception to the no-inline-imports rule).
		import('./routes/blog-area.ts'),
)

export const onboardingArea = createLazyRouteArea<OnboardingAreaModule>(
	() =>
		// Dynamic import is intentional for route-level code splitting
		// (sanctioned exception to the no-inline-imports rule).
		import('./routes/onboarding-area.ts'),
)

type LazyRouteRenderProps<TModule> = {
	render: (module: TModule) => JSX.Element
}

/**
 * Builds a remix/ui component bound to one lazy area. Closing over `area`
 * keeps `TModule` in the `render` callback (JSX generics on `Handle` props
 * do not infer through `<LazyRoute area={...} />`).
 *
 * Reads the module-level cache synchronously; when cold, kicks off `load()`
 * and returns null until the chunk arrives. SSR, hydration, and SPA
 * navigation preload the matching area before commit, so the async path is a
 * safety net.
 */
type LazyRouteComponent<TModule> = (
	handle: Handle<LazyRouteRenderProps<TModule>>,
) => () => JSX.Element | null

export function createLazyRoute<TModule>(
	area: LazyRouteArea<TModule>,
): LazyRouteComponent<TModule> {
	return function LazyRoute(handle: Handle<LazyRouteRenderProps<TModule>>) {
		let loadStarted = false

		return () => {
			const { render } = handle.props
			const module = area.getCached()
			if (module) return render(module)

			if (!loadStarted) {
				loadStarted = true
				handle.queueTask(async (signal) => {
					try {
						await area.load()
					} catch {
						return
					}
					if (signal.aborted) return
					handle.update()
				})
			}

			return null
		}
	}
}

export const LazyAccountRoute: LazyRouteComponent<AccountAreaModule> =
	createLazyRoute(accountArea)
export const LazyAdminRoute: LazyRouteComponent<AdminAreaModule> =
	createLazyRoute(adminArea)
export const LazyCommunityRoute: LazyRouteComponent<CommunityAreaModule> =
	createLazyRoute(communityArea)
export const LazyBlogRoute: LazyRouteComponent<BlogAreaModule> =
	createLazyRoute(blogArea)
export const LazyOnboardingRoute: LazyRouteComponent<OnboardingAreaModule> =
	createLazyRoute(onboardingArea)

export function lazyRouteLoader<TModule>(
	area: LazyRouteArea<TModule>,
	select: (module: TModule) => RouteLoader,
): RouteLoader {
	return async (url, signal) => {
		const module = await area.load()
		return select(module)(url, signal)
	}
}

const clientRouteOrigin = 'https://kody.local'

type PreloadArea = {
	/** Chunk name of the area barrel (matches the built `assets/<name>-<hash>.js`). */
	name: string
	load: () => Promise<unknown>
}

const preloadMatcher = createMultiMatcher<PreloadArea>()

function registerPreloadPatterns(
	patterns: ReadonlyArray<string>,
	area: PreloadArea,
) {
	for (const pattern of patterns) {
		preloadMatcher.add(pattern, area)
	}
}

registerPreloadPatterns(
	[
		routePattern(routes.account),
		routePattern(routes.accountBilling),
		routePattern(routes.accountUsage),
		routePattern(routes.accountIntegrations),
		routePattern(routes.accountOauthAppDetail),
		routePattern(routes.accountIntegrationDetail),
		routePattern(routes.accountMcpServers),
		routePattern(routes.accountMcpServerNew),
		routePattern(routes.accountMcpServerDetail),
		routePattern(routes.accountPackageInvocationTokens),
		routePattern(routes.accountPackageInvocationTokenNew),
		routePattern(routes.accountPackageInvocationTokenDetail),
		routePattern(routes.accountPackages),
		routePattern(routes.accountPackageDetail),
		routePattern(routes.accountStars),
		routePattern(routes.accountPasskeys),
		routePattern(routes.accountRemoteConnectors),
		routePattern(routes.accountRemoteConnectorNew),
		routePattern(routes.accountRemoteConnectorDetail),
		routePattern(routes.accountSecrets),
		routePattern(routes.accountSecretNew),
		routePattern(routes.accountSecretsApprove),
		routePattern(routes.accountSecretUserDetail),
		routePattern(routes.accountSecretPackageDetail),
		routePattern(routes.accountSecretSessionDetail),
		routePattern(routes.accountValues),
		routePattern(routes.accountValueNew),
		routePattern(routes.accountValueDetail),
		routePattern(routes.accountJobs),
		routePattern(routes.accountJobDetail),
		routePattern(routes.accountActivity),
		routePattern(routes.accountActivityDetail),
		routePattern(routes.accountMemories),
		routePattern(routes.accountMemoryDetail),
		routePattern(routes.accountEmail),
		routePattern(routes.accountEmailDetail),
		routePattern(routes.accountTwoFactor),
	],
	{ name: 'account-area', load: accountArea.load },
)

registerPreloadPatterns(
	[
		routePattern(routes.admin),
		routePattern(routes.adminUsers),
		routePattern(routes.adminUserDetail),
		routePattern(routes.adminInvites),
		routePattern(routes.adminFeatureFlags),
		routePattern(routes.adminRoles),
		routePattern(routes.adminCommunityReports),
		routePattern(routes.adminInsights),
		routePattern(routes.adminPlatformFeedback),
		routePattern(routes.adminSystemEmail),
	],
	{ name: 'admin-area', load: adminArea.load },
)

registerPreloadPatterns(
	[
		routePattern(routes.community),
		routePattern(routes.communityDetail),
		routePattern(routes.profile),
		routePattern(routes.timeline),
	],
	{ name: 'community-area', load: communityArea.load },
)

registerPreloadPatterns(
	[routePattern(routes.blog), routePattern(routes.blogPost)],
	{ name: 'blog-area', load: blogArea.load },
)

registerPreloadPatterns(
	[
		routePattern(routes.onboarding),
		routePattern(routes.connectOauth),
		oauthPaths.authorize,
	],
	{ name: 'onboarding-area', load: onboardingArea.load },
)

/**
 * Warms the lazy route chunk for `pathnameWithSearch` (pathname + search).
 * No-op for eager routes. Call before SSR stream, before hydration
 * `app.ready()`, and alongside SPA navigation loaders.
 */
export async function preloadClientRouteModules(
	pathnameWithSearch: string,
): Promise<void> {
	const url = new URL(pathnameWithSearch, clientRouteOrigin)
	const match = preloadMatcher.match(url)
	if (!match) return
	await match.data.load()
}

/**
 * Chunk name (e.g. `account-area`) of the lazy area serving
 * `pathnameWithSearch`, or null for eager routes. SSR uses it to emit
 * `modulepreload` links for the area chunk from the client manifest.
 */
export function clientRouteAreaNameForPath(
	pathnameWithSearch: string,
): string | null {
	const url = new URL(pathnameWithSearch, clientRouteOrigin)
	return preloadMatcher.match(url)?.data.name ?? null
}
