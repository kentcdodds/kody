import { type AppLoaderData } from '#universal/loader-data.ts'

/**
 * Loader result asking the router to leave the SPA with a full-document
 * navigation (for example, `401` → login). Loaders must return this instead
 * of calling `window.location.assign` themselves: intent prefetches run
 * loaders speculatively, and a prefetch must never redirect the page the
 * user is still looking at.
 */
export class RouteLoaderRedirect {
	constructor(readonly to: string) {}
}

export function routeLoaderRedirect(to: string): RouteLoaderRedirect {
	return new RouteLoaderRedirect(to)
}

export function isRouteLoaderRedirect(
	value: unknown,
): value is RouteLoaderRedirect {
	return value instanceof RouteLoaderRedirect
}

export type RouteLoaderResult = Partial<AppLoaderData> | RouteLoaderRedirect

export type RouteLoader = (
	url: URL,
	signal: AbortSignal,
) => Promise<RouteLoaderResult>
