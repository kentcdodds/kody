import { readAuthSessionResult } from '#server/auth-session.ts'
import { Layout } from '#server/layout.ts'
import { render } from '#server/render.ts'

function normalizeRedirectTo(value: string | null) {
	if (!value) return null
	if (!value.startsWith('/')) return null
	if (value.startsWith('//')) return null
	return value
}

export function createAuthPageHandler() {
	return {
		middleware: [],
		async action({ request }: { request: Request }) {
			const { session, setCookie } = await readAuthSessionResult(request)
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

			return render(Layout({}))
		},
	}
}
