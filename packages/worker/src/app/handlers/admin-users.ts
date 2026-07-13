import { readPositiveInt } from '#app/query-params.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { loadAdminUserUsageData } from '#app/admin-user-usage-data.ts'
import {
	loadAdminUserByIdOrEmail,
	loadAdminUsersData,
	loadRolesByUserIds,
	adminUserListItemFieldNames,
	updateAdminUserPlan,
	type AdminUserListItem,
} from '#app/admin-users-data.ts'
import { parsePlanName, type PlanName } from '#worker/entitlements/plans.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	assignUserRole,
	removeAdminRolePreservingLastAdmin,
	removeUserRole,
	requireUserWithPermission,
	requireUserWithRole,
} from '#app/permissions-server.ts'
import { type RoleName, roleNames } from '#app/permissions.ts'
import { type routes } from '#app/routes.ts'

export { adminUserListItemFieldNames, type AdminUserListItem }

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

			const { session } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			// The HTML page always seeds the first window; infinite scroll owns
			// later pages through the JSON API, so a stale `?page=N` link must
			// not anchor the list past the rows it can never load.
			const pageUrl = new URL(request.url)
			pageUrl.searchParams.delete('page')
			const adminUsers = await loadAdminUsersData(env, pageUrl.toString())

			return renderAppPage({
				request,
				env,
				title: 'Admin users',
				loaderData: { adminUsers },
			})
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
					const payload = await loadAdminUsersData(env, request.url)
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
				if (action === 'update_plan') {
					return handleUpdatePlanAction({
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

/**
 * Per-user usage drill-down for the admin users page. Loads usage for
 * exactly one account (the selected one) instead of a whole page of
 * users, so the cost per request stays constant as the user base grows.
 */
export function createAdminUserUsageApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				await requireUserWithPermission(request, env, 'read:user:any')
				const url = new URL(request.url)
				const userId = readPositiveInt(url.searchParams.get('userId'), 0)
				if (!userId) {
					return jsonResponse({ ok: false, error: 'userId is required.' }, 400)
				}
				const payload = await loadAdminUserUsageData(env, userId)
				if (!payload) {
					return jsonResponse({ ok: false, error: 'User not found.' }, 404)
				}
				return jsonResponse(payload)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminUserUsageApi>
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

	return buildMutationResponse(input.env, input.request.url, targetUserId)
}

/**
 * Mutation responses carry the refreshed page slice plus the updated target
 * user, because with infinite scroll the target may live outside the first
 * page and the client patches it in place instead of resetting the list.
 */
async function buildMutationResponse(
	env: Env,
	requestUrl: string,
	targetUserId: number,
) {
	const [payload, updatedUser] = await Promise.all([
		loadAdminUsersData(env, requestUrl),
		loadAdminUserByIdOrEmail(env.APP_DB, { id: targetUserId }),
	])
	return jsonResponse({ ...payload, updatedUser })
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

	return buildMutationResponse(input.env, input.request.url, targetUserId)
}

async function handleUpdatePlanAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetUserId = readPositiveInt(readString(input.body, 'userId'), 0)
	if (!targetUserId) {
		return jsonResponse({ ok: false, error: 'User id is required.' }, 400)
	}
	const planUpdate = readPlanUpdate(input.body)
	if (!planUpdate.ok) {
		return jsonResponse(
			{
				ok: false,
				error:
					'Plan must be one of the known plan names, or null to clear the plan.',
			},
			400,
		)
	}

	const updatedUser = await updateAdminUserPlan(input.env.APP_DB, {
		id: targetUserId,
		plan: planUpdate.plan,
	})
	if (!updatedUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		category: 'admin',
		action: 'update_plan',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_user_id=${targetUserId};plan=${planUpdate.plan ?? 'null'}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetUserId)
}

/**
 * Read the requested plan value: a known plan name sets it, explicit null
 * clears it (legacy/unlimited). Anything else — including a missing key or
 * an unknown plan string — is rejected instead of being coerced to null.
 */
function readPlanUpdate(
	body: object,
): { ok: true; plan: PlanName | null } | { ok: false } {
	if (!('plan' in body)) return { ok: false }
	const value = (body as Record<string, unknown>).plan
	if (value === null) return { ok: true, plan: null }
	if (typeof value === 'string') {
		const plan = parsePlanName(value.trim())
		if (plan) return { ok: true, plan }
	}
	return { ok: false }
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
