import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { Layout } from '#app/layout.ts'
import {
	assignUserRole,
	removeAdminRolePreservingLastAdmin,
	removeUserRole,
	requireUserWithPermission,
	requireUserWithRole,
} from '#app/permissions-server.ts'
import { type RoleName, roleNames } from '#app/permissions.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'

export const adminUserListItemFieldNames = [
	'id',
	'username',
	'email',
	'created_at',
	'updated_at',
	'roles',
] as const

export type AdminUserListItemFieldName =
	(typeof adminUserListItemFieldNames)[number]

export type AdminUserListItem = Record<AdminUserListItemFieldName, unknown> & {
	id: number
	username: string
	email: string
	created_at: string
	updated_at: string
	roles: Array<RoleName>
}

type AdminUsersListPayload = {
	ok: true
	users: Array<AdminUserListItem>
	page: number
	pageSize: number
	total: number
	availableRoles: Array<RoleName>
}

const defaultPageSize = 20
const maxPageSize = 100

export function createAdminHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				await requireUserWithRole(request, env, 'admin')
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
			return Response.redirect(new URL('/admin/users', request.url), 302)
		},
	} satisfies Action<typeof routes.admin>
}

export function createAdminUsersHandler(env: Env) {
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

			const response = render(Layout({ title: 'Admin users' }))
			if (setCookie) {
				response.headers.set('Set-Cookie', setCookie)
			}
			return response
		},
	} satisfies Action<typeof routes.adminUsers>
}

export function createAdminUsersApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
				if (request.method === 'GET') {
					await requireUserWithPermission(request, env, 'read:user:any')
					const payload = await buildAdminUsersListPayload({
						env,
						request,
					})
					return jsonResponse(payload)
				}

				if (request.method !== 'POST') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}

				const actor = await requireUserWithPermission(
					request,
					env,
					'update:user:any',
				)
				const body = await request.json().catch(() => null)
				if (!body || typeof body !== 'object') {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}

				const action = readString(body, 'action')
				if (action === 'assign_role') {
					return handleAssignRoleAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}
				if (action === 'remove_role') {
					return handleRemoveRoleAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}

				return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
			} catch (error) {
				if (error instanceof Response) {
					return error
				}
				throw error
			}
		},
	} satisfies Action<typeof routes.adminUsersApi>
}

async function buildAdminUsersListPayload(input: {
	env: Env
	request: Request
}): Promise<AdminUsersListPayload> {
	const requestUrl = new URL(input.request.url)
	const page = readPositiveInt(requestUrl.searchParams.get('page'), 1)
	const pageSize = Math.min(
		readPositiveInt(requestUrl.searchParams.get('pageSize'), defaultPageSize),
		maxPageSize,
	)
	const offset = (page - 1) * pageSize

	const totalResult = await input.env.APP_DB.prepare(
		`SELECT COUNT(*) AS total FROM users`,
	).first<{ total: number }>()
	const total = totalResult?.total ?? 0

	const userRows = await input.env.APP_DB.prepare(
		`SELECT id, username, email, created_at, updated_at
		 FROM users
		 ORDER BY id ASC
		 LIMIT ? OFFSET ?`,
	)
		.bind(pageSize, offset)
		.all<{
			id: number
			username: string
			email: string
			created_at: string
			updated_at: string
		}>()

	const userIds = (userRows.results ?? []).map((row) => row.id)
	const rolesByUserId = await loadRolesByUserIds(input.env.APP_DB, userIds)

	return {
		ok: true,
		users: (userRows.results ?? []).map((row) =>
			toAdminUserListItem(row, rolesByUserId.get(row.id) ?? []),
		),
		page,
		pageSize,
		total,
		availableRoles: [...roleNames],
	}
}

async function loadRolesByUserIds(db: D1Database, userIds: Array<number>) {
	const rolesByUserId = new Map<number, Array<RoleName>>()
	if (userIds.length === 0) {
		return rolesByUserId
	}

	const placeholders = userIds.map(() => '?').join(', ')
	const result = await db
		.prepare(
			`SELECT ur.user_id, r.name AS role_name
			 FROM user_roles ur
			 INNER JOIN roles r ON r.id = ur.role_id
			 WHERE ur.user_id IN (${placeholders})
			 ORDER BY ur.user_id ASC, r.name ASC`,
		)
		.bind(...userIds)
		.all<{ user_id: number; role_name: string }>()

	for (const row of result.results ?? []) {
		if (!isRoleName(row.role_name)) continue
		const current = rolesByUserId.get(row.user_id) ?? []
		current.push(row.role_name)
		rolesByUserId.set(row.user_id, current)
	}

	return rolesByUserId
}

function toAdminUserListItem(
	row: {
		id: number
		username: string
		email: string
		created_at: string
		updated_at: string
	},
	roles: Array<RoleName>,
): AdminUserListItem {
	return {
		id: row.id,
		username: row.username,
		email: row.email,
		created_at: row.created_at,
		updated_at: row.updated_at,
		roles,
	}
}

async function handleAssignRoleAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetUserId = readPositiveInt(readString(input.body, 'userId'), 0)
	const roleName = readRoleName(input.body, 'role')
	if (!targetUserId) {
		return jsonResponse({ ok: false, error: 'User id is required.' }, 400)
	}
	if (!roleName) {
		return jsonResponse({ ok: false, error: 'Role is required.' }, 400)
	}

	const targetUser = await input.env.APP_DB.prepare(
		`SELECT id, email FROM users WHERE id = ?`,
	)
		.bind(targetUserId)
		.first<{ id: number; email: string }>()
	if (!targetUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	await assignUserRole({
		db: input.env.APP_DB,
		userId: targetUserId,
		roleName,
	})

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		category: 'admin',
		action: 'assign_role',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_user_id=${targetUserId};role=${roleName}`,
	})

	const payload = await buildAdminUsersListPayload({
		env: input.env,
		request: input.request,
	})
	return jsonResponse(payload)
}

async function handleRemoveRoleAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetUserId = readPositiveInt(readString(input.body, 'userId'), 0)
	const roleName = readRoleName(input.body, 'role')
	if (!targetUserId) {
		return jsonResponse({ ok: false, error: 'User id is required.' }, 400)
	}
	if (!roleName) {
		return jsonResponse({ ok: false, error: 'Role is required.' }, 400)
	}

	const targetUser = await input.env.APP_DB.prepare(
		`SELECT id, email FROM users WHERE id = ?`,
	)
		.bind(targetUserId)
		.first<{ id: number; email: string }>()
	if (!targetUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	if (roleName === 'admin') {
		// The last-admin check runs inside the DELETE statement itself so two
		// concurrent removals cannot both pass a stale count and leave the
		// deployment with zero admins.
		const { removed } = await removeAdminRolePreservingLastAdmin({
			db: input.env.APP_DB,
			userId: targetUserId,
		})
		if (!removed) {
			const targetRoles = await loadRolesByUserIds(input.env.APP_DB, [
				targetUserId,
			])
			const targetStillAdmin = (targetRoles.get(targetUserId) ?? []).includes(
				'admin',
			)
			if (targetStillAdmin) {
				const requestIp = getRequestIp(input.request) ?? undefined
				void logAuditEvent({
					category: 'admin',
					action: 'remove_role',
					result: 'failure',
					email: input.actor.email,
					ip: requestIp,
					path: input.url.pathname,
					reason: 'last_admin',
				})
				return jsonResponse(
					{
						ok: false,
						error:
							'Cannot remove the admin role from the last remaining admin account.',
					},
					409,
				)
			}
			// The target did not have the admin role; removal is an idempotent
			// no-op, matching non-admin role removal behavior.
		}
	} else {
		await removeUserRole({
			db: input.env.APP_DB,
			userId: targetUserId,
			roleName,
		})
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		category: 'admin',
		action: 'remove_role',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_user_id=${targetUserId};role=${roleName}`,
	})

	const payload = await buildAdminUsersListPayload({
		env: input.env,
		request: input.request,
	})
	return jsonResponse(payload)
}

function isRoleName(value: string): value is RoleName {
	return (roleNames as ReadonlyArray<string>).includes(value)
}

function readRoleName(body: object, key: string): RoleName | null {
	const value = readString(body, key)
	return value && isRoleName(value) ? value : null
}

function readString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	if (typeof value === 'string' && value.trim()) {
		return value.trim()
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return String(value)
	}
	return null
}

function readPositiveInt(value: string | null, fallback: number) {
	if (!value) return fallback
	const parsed = Number.parseInt(value, 10)
	if (!Number.isFinite(parsed) || parsed < 1) {
		return fallback
	}
	return parsed
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
