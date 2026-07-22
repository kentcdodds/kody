import { type Action } from 'remix/router'
import { loadAccountStarsData } from '#app/account-stars-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { type routes } from '#app/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { jsonResponse } from '#worker/json-response.ts'

export function createAccountStarsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountStars = await loadAccountStarsData({
				env,
				userId: user.mcpUser.userId,
			})
			return renderAppPage({
				request,
				env,
				title: 'Starred packages',
				loaderData: { accountStars },
			})
		},
	} satisfies Action<typeof routes.accountStars>
}

export function createAccountStarsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			return jsonResponse(
				await loadAccountStarsData({
					env,
					userId: user.mcpUser.userId,
				}),
			)
		},
	} satisfies Action<typeof routes.accountStarsApi>
}
