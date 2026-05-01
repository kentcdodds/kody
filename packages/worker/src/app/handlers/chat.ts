import { type BuildAction } from 'remix/fetch-router'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'

export const chat = {
	middleware: [],
	async handler({ request }) {
		const { session, setCookie } = await readAuthSessionResult(request)

		if (!session) {
			return redirectToLogin(request)
		}

		const response = render(Layout({}))
		if (setCookie) {
			response.headers.set('Set-Cookie', setCookie)
		}

		return response
	},
} satisfies BuildAction<typeof routes.chat.method, typeof routes.chat.pattern>
