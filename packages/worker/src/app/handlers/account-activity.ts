import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountActivityData } from '#app/account-activity-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type AccountActivityLoaderData as AppAccountActivityLoaderData } from '#universal/loader-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { type routes } from '#universal/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'

function readPathRunId(params: unknown) {
	if (
		typeof params === 'object' &&
		params !== null &&
		'runId' in params &&
		typeof params.runId === 'string'
	) {
		return params.runId
	}
	return undefined
}

/**
 * Page handler for `/account/activity` and `/account/activity/:runId`.
 */
export function createAccountActivityHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountActivity = await loadAccountActivityData({
				env,
				request,
				user,
				pathRunId: readPathRunId(params),
			})
			return renderAppPage({
				request,
				env,
				title: 'Activity',
				loaderData: {
					accountActivity: accountActivity as AppAccountActivityLoaderData,
				},
			})
		},
	} satisfies Action<
		typeof routes.accountActivity | typeof routes.accountActivityDetail
	>
}

/**
 * JSON API for `/account/activity.json` (GET list/detail + pagination).
 */
export function createAccountActivityApiHandler(env: Env) {
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
				await loadAccountActivityData({
					env,
					request,
					user,
				}),
			)
		},
	} satisfies Action<typeof routes.accountActivityApi>
}
