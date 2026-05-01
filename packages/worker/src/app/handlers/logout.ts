import { type BuildAction } from 'remix/fetch-router'
import { destroyAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { type routes } from '#app/routes.ts'

export const logout = {
	middleware: [],
	async handler({ request }) {
		const cookie = await destroyAuthCookie(isSecureRequest(request))
		const location = new URL('/login', request.url)

		return new Response(null, {
			status: 302,
			headers: {
				Location: location.toString(),
				'Set-Cookie': cookie,
			},
		})
	},
} satisfies BuildAction<
	typeof routes.logout.method,
	typeof routes.logout.pattern
>
