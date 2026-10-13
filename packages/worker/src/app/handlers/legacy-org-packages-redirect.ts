import { type Action } from 'remix/router'
import { routes } from '#universal/routes.ts'

/**
 * `/@slug/-/packages` and `/@slug/-/packages.json` renamed to
 * `/@slug/-/repositories` (+ `.json`). Keep permanent redirects so bookmarks
 * and external links keep working; query strings survive.
 */
export function resolveLegacyOrgPackagesLocation(url: URL): string | null {
	const match = /^\/@([^/]+)\/-\/packages(\.json)?\/?$/.exec(url.pathname)
	if (!match) return null
	const orgSlug = match[1] ?? ''
	const isApi = match[2] === '.json'
	const path = isApi
		? routes.orgRepositoriesApi.href({ orgSlug })
		: routes.orgRepositories.href({ orgSlug })
	return `${path}${url.search}`
}

function redirectResponse(request: Request): Response {
	const location =
		resolveLegacyOrgPackagesLocation(new URL(request.url)) ?? routes.home.href()
	return new Response(null, {
		status: 301,
		headers: {
			Location: location,
			'Cache-Control': 'public, max-age=3600',
		},
	})
}

export function createLegacyOrgPackagesRedirectHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return redirectResponse(request)
		},
	} satisfies Action<typeof routes.orgPackages>
}

export function createLegacyOrgPackagesApiRedirectHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return redirectResponse(request)
		},
	} satisfies Action<typeof routes.orgPackagesApi>
}
