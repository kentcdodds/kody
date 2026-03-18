import { type BuildAction } from 'remix/fetch-router'
import { readAuthSessionResult } from '#server/auth-session.ts'
import { redirectToLogin } from '#server/auth-redirect.ts'
import { Layout } from '#server/layout.ts'
import { render } from '#server/render.ts'
import { type routes } from '#server/routes.ts'

export const account = {
	middleware: [],
	async action({ request }) {
		const { session, setCookie } = await readAuthSessionResult(request)

		if (!session) {
			return redirectToLogin(request)
		}

		const response = render(
			Layout({
				title: 'Account',
			}),
		)
		if (setCookie) {
			response.headers.set('Set-Cookie', setCookie)
		}

		return response
	},
} satisfies BuildAction<
	typeof routes.account.method,
	typeof routes.account.pattern
>
