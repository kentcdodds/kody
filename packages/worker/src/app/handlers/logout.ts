import { type Action } from 'remix/router'
import { destroyAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { type routes } from '#universal/routes.ts'

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
} satisfies Action<typeof routes.logout>
