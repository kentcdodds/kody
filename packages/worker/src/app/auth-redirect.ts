import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'

type RedirectToLoginOptions = {
	redirectTo?: string
	setCookie?: string
}

/** Allow only same-origin absolute paths as post-auth redirect targets. */
export function normalizeRedirectTo(value: string | null) {
	if (!value) return null
	if (!value.startsWith('/')) return null
	if (value.startsWith('//')) return null
	return value
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
