import { type BuildAction } from 'remix/fetch-router'
import {
	destroyAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
} from '#app/auth-session.ts'
import { type routes } from '#app/routes.ts'
import { createDb, usersTable } from '#worker/db.ts'

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

export function createSessionHandler(env: Env) {
	const db = createDb(env.APP_DB)

	return {
		middleware: [],
		async handler({ request }) {
			const { session, setCookie } = await readAuthSessionResult(request)
			if (!session) {
				return jsonResponse({ ok: false })
			}

			const userId = /^\d+$/.test(session.id) ? Number(session.id) : NaN
			const userRecord =
				Number.isSafeInteger(userId) && userId > 0
					? await db.findOne(usersTable, { where: { id: userId } })
					: null
			if (!userRecord) {
				return jsonResponse(
					{ ok: false },
					{
						headers: {
							'Set-Cookie': await destroyAuthCookie(isSecureRequest(request)),
						},
					},
				)
			}

			return jsonResponse(
				{
					ok: true,
					session: {
						email: userRecord.email,
						username: userRecord.username,
					},
				},
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
}
