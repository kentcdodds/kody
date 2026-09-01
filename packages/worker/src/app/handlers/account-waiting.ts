import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountWaitingData } from '#app/account-waiting-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

export function createAccountWaitingHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountWaiting = await loadAccountWaitingData({ env, user })
			return renderAppPage({
				request,
				env,
				title: 'Waiting',
				loaderData: { accountWaiting },
			})
		},
	} satisfies Action<typeof routes.accountWaiting>
}

export function createAccountWaitingApiHandler(env: Env) {
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

			const accountWaiting = await loadAccountWaitingData({ env, user })
			return jsonResponse(accountWaiting)
		},
	} satisfies Action<typeof routes.accountWaitingApi>
}
