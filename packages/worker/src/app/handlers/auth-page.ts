import { getAppBaseUrl } from '#app/app-base-url.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import {
	getEnabledOauthProviders,
	oauthProviderDefinitions,
} from '#app/oauth-providers.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { createPageOgHeadNode } from '#app/ssr-document.tsx'
import { renderAppPage } from '#app/ssr-render.tsx'

export function createAuthPageHandler(env: Env, pageId: 'login' | 'signup') {
	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			const { session, setCookie } = await loadSessionInfo(request, env)
			if (session) {
				const url = new URL(request.url)
				const redirectTo = normalizeRedirectTo(
					url.searchParams.get('redirectTo'),
				)
				const redirectTarget = redirectTo ?? '/account'
				const redirectUrl = new URL(redirectTarget, request.url)
				if (setCookie) {
					return new Response(null, {
						status: 302,
						headers: {
							Location: redirectUrl.toString(),
							'Set-Cookie': setCookie,
						},
					})
				}

				return Response.redirect(redirectUrl, 302)
			}

			const origin = getAppBaseUrl({ env, requestUrl: request.url })

			// Server-render the social login buttons with the rest of the
			// page: the enabled-provider list is deployment configuration,
			// not per-user data, so there is nothing to lazily load.
			return renderAppPage({
				request,
				env,
				extraHead: createPageOgHeadNode({ origin, pageId }),
				loaderData: {
					authProviders: {
						ok: true,
						providers: getEnabledOauthProviders(env).map((provider) => ({
							id: provider,
							label: oauthProviderDefinitions[provider].label,
						})),
					},
				},
			})
		},
	}
}
