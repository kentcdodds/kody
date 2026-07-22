import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAdminRolesData } from '#app/admin-roles-data.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { requireUserWithPermission } from '#app/permissions-server.ts'
import { type routes } from '#app/routes.ts'

export function createAdminRolesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}

			const adminRoles = await loadAdminRolesData(env)

			return renderAppPage({
				request,
				env,
				title: 'Admin roles',
				loaderData: { adminRoles },
			})
		},
	} satisfies Action<typeof routes.adminRoles>
}

export function createAdminRolesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				await requireUserWithPermission(request, env, 'read:role:any')
				const payload = await loadAdminRolesData(env)
				return jsonResponse(payload)
			} catch (error) {
				if (error instanceof Response) {
					return error
				}
				throw error
			}
		},
	} satisfies Action<typeof routes.adminRolesApi>
}
