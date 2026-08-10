import { type Action } from 'remix/router'
import { jsonResponse } from '#worker/json-response.ts'
import { loadAdminInsightsData } from '#app/admin-insights-data.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { type routes } from '#universal/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'

export function createAdminInsightsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}

			const adminInsights = await loadAdminInsightsData(env)

			return renderAppPage({
				request,
				env,
				title: 'Admin insights',
				loaderData: { adminInsights },
			})
		},
	} satisfies Action<typeof routes.adminInsights>
}

export function createAdminInsightsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				await requireUserWithRole(request, env, 'admin')
				const payload = await loadAdminInsightsData(env)
				return jsonResponse(payload)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminInsightsApi>
}
