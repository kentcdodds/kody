import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountUsageData } from '#app/account-usage-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

export function createAccountUsageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountUsage = await loadAccountUsageData({
				env,
				userId: user.userId,
			})
			if (!accountUsage) {
				return new Response('Not found', { status: 404 })
			}
			return renderAppPage({
				request,
				env,
				title: 'Usage',
				loaderData: { accountUsage },
			})
		},
	} satisfies Action<typeof routes.accountUsage>
}

export function createAccountUsageApiHandler(env: Env) {
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

			const accountUsage = await loadAccountUsageData({
				env,
				userId: user.userId,
			})
			if (!accountUsage) {
				return jsonResponse({ ok: false, error: 'Not found.' }, 404)
			}
			return jsonResponse(accountUsage)
		},
	} satisfies Action<typeof routes.accountUsageApi>
}
