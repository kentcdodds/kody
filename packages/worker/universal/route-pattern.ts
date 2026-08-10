import { type routes } from '#universal/routes.ts'

type AppRoute = (typeof routes)[keyof typeof routes]

/**
 * Pathname pattern string for a `routes.ts` entry (e.g. `/account/:id`).
 * Use as the key in client route/loader registries and document-head so path
 * renames flow from `routes.ts` instead of duplicated literals.
 */
export function routePattern(route: AppRoute): string {
	return String(route.pattern)
}
