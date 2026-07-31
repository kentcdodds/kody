import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import {
	getEnabledOauthProviders,
	oauthProviderDefinitions,
} from '#app/oauth-providers.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { getTurnstileSiteKey } from '#app/public-form-protection.ts'
import { getSignupMode } from '#app/signup-mode.ts'

export function createAuthPageHandler(
	env: Env,
	// Retained so login/signup call sites stay explicit; head metadata comes
	// from the document-head registry keyed by request pathname.
	_pageId: 'login' | 'signup',
) {
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

			// Server-render the social login buttons with the rest of the
			// page: the enabled-provider list is deployment configuration,
			// not per-user data, so there is nothing to lazily load.
			// Document title/OG come from the shared registry by pathname
			// (`/login` vs `/signup`).
			return renderAppPage({
				request,
				env,
				loaderData: {
					authProviders: {
						ok: true,
						signupMode: getSignupMode(env),
						turnstileSiteKey: getTurnstileSiteKey(env),
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
