import { type Action } from 'remix/router'
import { orgResourcePath } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'

/**
 * `/@slug/-/connections(/…)` renamed to `/@slug/-/agents(/…)`. Keep
 * permanent redirects so bookmarks, emails, and agent-printed links keep
 * working; the rest of the path and the query survive.
 */
export function resolveLegacyOrgConnectionsLocation(url: URL): string | null {
	const match = /^\/@([^/]+)\/-\/connections(?:\/(.*))?$/.exec(url.pathname)
	if (!match) return null
	return `${orgResourcePath(match[1] ?? '', 'agents', match[2])}${url.search}`
}

export function createLegacyOrgConnectionsRedirectHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const location =
				resolveLegacyOrgConnectionsLocation(new URL(request.url)) ??
				routes.home.href()
			return new Response(null, {
				status: 301,
				headers: {
					Location: location,
					'Cache-Control': 'public, max-age=3600',
				},
			})
		},
	} satisfies Action<typeof routes.orgConnections>
}
