type RedirectToLoginOptions = {
	redirectTo?: string
}

function normalizeRedirectTo(value: string | null) {
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

	return Response.redirect(loginUrl, 302)
}
