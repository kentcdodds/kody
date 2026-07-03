import { type Action } from 'remix/router'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { Layout } from '#app/layout.ts'
import {
	requireUserWithPermission,
	requireUserWithRole,
} from '#app/permissions-server.ts'
import { type PermissionString } from '#app/permissions.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'

type AdminRoleListItem = {
	name: string
	description: string
	permissions: Array<PermissionString>
}

type AdminRolesListPayload = {
	ok: true
	roles: Array<AdminRoleListItem>
}

export function createAdminRolesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				await requireUserWithRole(request, env, 'admin')
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}

			const { session, setCookie } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const response = render(Layout({ title: 'Admin roles' }))
			if (setCookie) {
				response.headers.set('Set-Cookie', setCookie)
			}
			return response
		},
	} satisfies Action<typeof routes.adminRoles>
}

export function createAdminRolesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				await requireUserWithPermission(request, env, 'read:role:any')
				const payload = await buildAdminRolesListPayload(env)
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

async function buildAdminRolesListPayload(
	env: Env,
): Promise<AdminRolesListPayload> {
	const roleRows = await env.APP_DB.prepare(
		`SELECT name, description FROM roles ORDER BY name ASC`,
	).all<{ name: string; description: string }>()

	const permissionRows = await env.APP_DB.prepare(
		`SELECT r.name AS role_name, p.action, p.entity, p.access
		 FROM roles r
		 INNER JOIN role_permissions rp ON rp.role_id = r.id
		 INNER JOIN permissions p ON p.id = rp.permission_id
		 ORDER BY r.name ASC, p.action ASC, p.entity ASC, p.access ASC`,
	).all<{
		role_name: string
		action: string
		entity: string
		access: string
	}>()

	const permissionsByRole = new Map<string, Array<PermissionString>>()
	for (const row of permissionRows.results ?? []) {
		const permission =
			`${row.action}:${row.entity}:${row.access}` as PermissionString
		const current = permissionsByRole.get(row.role_name) ?? []
		current.push(permission)
		permissionsByRole.set(row.role_name, current)
	}

	return {
		ok: true,
		roles: (roleRows.results ?? []).map((row) => ({
			name: row.name,
			description: row.description,
			permissions: permissionsByRole.get(row.name) ?? [],
		})),
	}
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}
