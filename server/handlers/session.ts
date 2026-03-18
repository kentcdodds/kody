import { type BuildAction } from 'remix/fetch-router'
import { readAuthSessionResult } from '#server/auth-session.ts'
import { type routes } from '#server/routes.ts'

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
	async action({ request }) {
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
