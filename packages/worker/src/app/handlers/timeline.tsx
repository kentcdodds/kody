/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { type routes } from '#app/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { loadTimelineData } from '#app/timeline-data.ts'
import { jsonResponse } from '#worker/json-response.ts'

export function createTimelineHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const timeline = await loadTimelineData({
				env,
				userId: user.mcpUser.userId,
			})
			return renderAppPage({
				request,
				env,
				title: 'Timeline',
				loaderData: { timeline },
			})
		},
	} satisfies Action<typeof routes.timeline>
}

export function createTimelineApiHandler(env: Env) {
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
				await loadTimelineData({
					env,
					userId: user.mcpUser.userId,
				}),
			)
		},
	} satisfies Action<typeof routes.timelineApi>
}
