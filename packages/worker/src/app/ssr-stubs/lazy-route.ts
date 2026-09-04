/**
 * Worker-typecheck stub for `#client/lazy-route.tsx`.
 * Runtime SSR uses the real client module (package imports / bundler).
 */
export type ClientRouteAreaName =
	| 'account-area'
	| 'admin-area'
	| 'auth-area'
	| 'blog-area'
	| 'community-area'
	| 'marketing-area'
	| 'onboarding-area'
	| 'package-files-area'

export async function preloadClientRouteModules(
	_pathnameWithSearch: string,
): Promise<void> {}

export function clientRouteAreaNameForPath(
	_pathnameWithSearch: string,
): ClientRouteAreaName | null {
	return null
}
