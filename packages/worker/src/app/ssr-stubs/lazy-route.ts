/**
 * Worker-typecheck stub for `#client/lazy-route.tsx`.
 * Runtime SSR uses the real client module (package imports / bundler).
 */
export async function preloadClientRouteModules(
	_pathnameWithSearch: string,
): Promise<void> {}

export function clientRouteAreaNameForPath(
	_pathnameWithSearch: string,
): string | null {
	return null
}
