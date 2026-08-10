import { type Action } from 'remix/router'
import { requirePageSession } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

/**
 * Every working visit to /connect/oauth carries at least one of these:
 * `provider` (agent-built setup URLs and built-in connects), `code` (the
 * provider's success redirect — config is restored from sessionStorage, so
 * the query has no provider), or `error` (the provider's denial redirect).
 * A visit with none of them has no flow to resume — someone typed the URL
 * or followed a bare link — so the OAuth guide is the useful destination.
 * Checked before the session gate: the guide is public.
 */
export function isBareConnectOauthVisit(url: URL): boolean {
	const params = url.searchParams
	return !params.get('provider') && !params.get('code') && !params.get('error')
}

export function createConnectOauthHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const requestUrl = new URL(request.url)
			if (isBareConnectOauthVisit(requestUrl)) {
				return Response.redirect(new URL('/guides/oauth', requestUrl), 302)
			}
			const sessionRedirect = await requirePageSession(request)
			if (sessionRedirect) {
				return sessionRedirect
			}
			return renderAppPage({
				request,
				env,
				title: 'Connect OAuth',
			})
		},
	} satisfies Action<typeof routes.connectOauth>
}
