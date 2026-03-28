import { type BuildAction } from 'remix/fetch-router'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'

export function createConnectOauthHandler(_env: Env) {
	return {
		middleware: [],
		async action({ request }) {
			const { session, setCookie } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}
			const response = render(Layout({ title: 'Connect OAuth' }))
			if (setCookie) {
				response.headers.set('Set-Cookie', setCookie)
			}
			return response
		},
	} satisfies BuildAction<
		typeof routes.connectOauth.method,
		typeof routes.connectOauth.pattern
	>
}
