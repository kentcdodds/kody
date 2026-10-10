import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import { publicAuthProvidersLoaderData } from '#app/public-auth-providers.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { renderAppPage } from '#app/ssr-render.tsx'

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
			// (`/login` vs `/signup`). Anonymous HTML is viewer-independent
			// (no CSRF token, no session embed) and shares the marketing
			// edge-cache path; a session cookie redirects above or forces
			// no-store via resolveAppPageCacheControl.
			return renderAppPage({
				request,
				env,
				extraSetCookies: setCookie ? [setCookie] : undefined,
				loaderData: {
					authProviders: publicAuthProvidersLoaderData(env),
				},
			})
		},
	}
}
