import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import { normalizeRedirectTo } from '#app/safe-redirect.ts'

export { normalizeRedirectTo }

type RedirectToLoginOptions = {
	redirectTo?: string
	setCookie?: string
}

export function redirectToLogin(
	request: Request,
	options: RedirectToLoginOptions = {},
) {
	const requestUrl = new URL(request.url)
	const target =
		normalizeRedirectTo(options.redirectTo ?? null) ??
		`${requestUrl.pathname}${requestUrl.search}`
	const loginUrl = new URL('/login', requestUrl)

	if (target) {
		loginUrl.searchParams.set('redirectTo', target)
	}

	if (options.setCookie) {
		return new Response(null, {
			status: 302,
			headers: {
				Location: loginUrl.toString(),
				'Set-Cookie': options.setCookie,
			},
		})
	}

	return Response.redirect(loginUrl, 302)
}

export async function redirectToLoginWhenUnauthenticated(
	request: Request,
	env: Env,
	options: RedirectToLoginOptions = {},
) {
	const resolved = await loadResolvedRequestAuth(request, env)
	return redirectToLogin(request, {
		...options,
		setCookie: resolved.setCookie,
	})
}
