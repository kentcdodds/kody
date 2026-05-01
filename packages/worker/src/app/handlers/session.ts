import { type BuildAction } from 'remix/fetch-router'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { type routes } from '#app/routes.ts'

function jsonResponse(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...init?.headers,
		},
	})
}

export const session = {
	middleware: [],
	async handler({ request }) {
		const { session, setCookie } = await readAuthSessionResult(request)
		if (!session) {
			return jsonResponse({ ok: false })
		}

		return jsonResponse(
			{ ok: true, session: { email: session.email } },
			setCookie
				? {
						headers: {
							'Set-Cookie': setCookie,
						},
					}
				: undefined,
		)
	},
} satisfies BuildAction<
	typeof routes.session.method,
	typeof routes.session.pattern
>
