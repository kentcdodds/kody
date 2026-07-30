import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import { loadAdminUserUsageData } from '#worker/admin/user-usage-data.ts'
import {
	clearAdminUserEmailOutboundPause,
	loadAdminUserByTarget,
	loadAdminUserRowByStableUserId,
	loadAdminUsersData,
	loadRolesByUserIds,
	adminUserListItemFieldNames,
	updateAdminUserPlan,
	updateAdminUserSuspension,
	type AdminUserListItem,
} from '#worker/admin/users-data.ts'
import {
	parsePlanName,
	resolvePlanWrite,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	assignUserRole,
	removeAdminRolePreservingLastAdmin,
	removeUserRole,
	requireUserWithPermission,
} from '#app/permissions-server.ts'
import { type RoleName, roleNames } from '#worker/identity/permissions.ts'
import { readNonEmptyTrimmedStringOrNumber } from '#app/request-body.ts'
import { type routes } from '#app/routes.ts'
import { isStableUserId, normalizeStableUserId } from '#worker/user-id.ts'

export { adminUserListItemFieldNames, type AdminUserListItem }

export function createAdminHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}
			return Response.redirect(new URL('/admin/users', request.url), 302)
		},
	} satisfies Action<typeof routes.admin>
}

export function createAdminUsersHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}

			// The HTML page always seeds the first window; infinite scroll owns
			// later pages through the JSON API, so a stale `?page=N` link must
			// not anchor the list past the rows it can never load.
			const pageUrl = new URL(request.url)
			pageUrl.searchParams.delete('page')
			const pathStableUserId =
				typeof params === 'object' &&
				params !== null &&
				'stableUserId' in params &&
				typeof params.stableUserId === 'string'
					? params.stableUserId
					: undefined
			const adminUsers = await loadAdminUsersData(
				env,
				pageUrl.toString(),
				pathStableUserId,
			)

			return renderAppPage({
				request,
				env,
				title: 'Admin users',
				loaderData: { adminUsers },
			})
		},
	} satisfies Action<typeof routes.adminUsers | typeof routes.adminUserDetail>
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

				const action = readNonEmptyTrimmedStringOrNumber(body, 'action')
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
				if (action === 'suspend_user' || action === 'unsuspend_user') {
					return handleSuspensionAction({
						env,
						request,
						url,
						actor,
						body,
						suspended: action === 'suspend_user',
					})
				}
				if (action === 'resume_email_outbound') {
					return handleResumeEmailOutboundAction({
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
				const stableUserId = url.searchParams.get('stableUserId')?.trim() ?? ''
				if (!isStableUserId(stableUserId)) {
					return jsonResponse(
						{ ok: false, error: 'stableUserId is required.' },
						400,
					)
				}
				const payload = await loadAdminUserUsageData(env, stableUserId)
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
	const targetStableUserId = readStableUserIdField(input.body)
	const roleName = readRoleName(input.body, 'role')
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	if (!roleName) {
		return jsonResponse({ ok: false, error: 'Role is required.' }, 400)
	}

	const targetUser = await loadAdminUserRowByStableUserId(
		input.env.APP_DB,
		targetStableUserId,
	)
	if (!targetUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	await assignUserRole({
		db: input.env.APP_DB,
		userId: targetUser.id,
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
		reason: `target_stable_user_id=${targetStableUserId};role=${roleName}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

/**
 * Mutation responses carry the refreshed page slice plus the updated target
 * user, because with infinite scroll the target may live outside the first
 * page and the client patches it in place instead of resetting the list.
 */
async function buildMutationResponse(
	env: Env,
	requestUrl: string,
	targetStableUserId: string,
) {
	const [payload, updatedUser] = await Promise.all([
		loadAdminUsersData(env, requestUrl),
		loadAdminUserByTarget(env.APP_DB, { stableUserId: targetStableUserId }),
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
	const targetStableUserId = readStableUserIdField(input.body)
	const roleName = readRoleName(input.body, 'role')
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	if (!roleName) {
		return jsonResponse({ ok: false, error: 'Role is required.' }, 400)
	}

	const targetUser = await loadAdminUserRowByStableUserId(
		input.env.APP_DB,
		targetStableUserId,
	)
	if (!targetUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	if (roleName === 'admin') {
		// The last-admin check runs inside the DELETE statement itself so two
		// concurrent removals cannot both pass a stale count and leave the
		// deployment with zero admins.
		const { removed } = await removeAdminRolePreservingLastAdmin({
			db: input.env.APP_DB,
			userId: targetUser.id,
		})
		if (!removed) {
			const targetRoles = await loadRolesByUserIds(input.env.APP_DB, [
				targetUser.id,
			])
			const targetStillAdmin = (targetRoles.get(targetUser.id) ?? []).includes(
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
			userId: targetUser.id,
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
		reason: `target_stable_user_id=${targetStableUserId};role=${roleName}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

async function handleUpdatePlanAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetStableUserId = readStableUserIdField(input.body)
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	const planUpdate = readPlanUpdate(input.body)
	if (!planUpdate.ok) {
		return jsonResponse(
			{
				ok: false,
				error: 'Plan must be one of the known plan names, or null for free.',
			},
			400,
		)
	}

	const updatedUser = await updateAdminUserPlan(input.env.APP_DB, {
		stableUserId: targetStableUserId,
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
		reason: `target_stable_user_id=${targetStableUserId};plan=${planUpdate.plan}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

/**
 * Set or clear the platform suspension. Unlike a community ban (community
 * surfaces only), suspension is fail-closed at the browser-session, MCP,
 * and email chokepoints.
 */
async function handleSuspensionAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
	suspended: boolean
}) {
	const targetStableUserId = readStableUserIdField(input.body)
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	if (input.suspended && targetStableUserId === input.actor.mcpUser.userId) {
		return jsonResponse(
			{ ok: false, error: 'You cannot suspend your own account.' },
			400,
		)
	}

	const updatedUser = await updateAdminUserSuspension(input.env.APP_DB, {
		stableUserId: targetStableUserId,
		suspended: input.suspended,
	})
	if (!updatedUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		category: 'admin',
		action: input.suspended ? 'suspend_user' : 'unsuspend_user',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_stable_user_id=${targetStableUserId}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

/**
 * Clear an automatic outbound-email pause (set by the delivery-event
 * abuse monitor) after reviewing the account's delivery history.
 */
async function handleResumeEmailOutboundAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetStableUserId = readStableUserIdField(input.body)
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}

	const updatedUser = await clearAdminUserEmailOutboundPause(input.env.APP_DB, {
		stableUserId: targetStableUserId,
	})
	if (!updatedUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		category: 'admin',
		action: 'resume_email_outbound',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_stable_user_id=${targetStableUserId}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

/**
 * Read the requested plan value: a known plan name sets it; explicit null
 * (and empty string) map to `free` (the normal default). Writers never
 * persist NULL. Missing key or unknown plan strings are rejected.
 */
function readPlanUpdate(
	body: object,
): { ok: true; plan: PlanName } | { ok: false } {
	if (!('plan' in body)) return { ok: false }
	const value = (body as Record<string, unknown>).plan
	if (value === null) return { ok: true, plan: resolvePlanWrite(null) }
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (!trimmed) return { ok: true, plan: resolvePlanWrite(null) }
		const plan = parsePlanName(trimmed)
		if (plan) return { ok: true, plan }
	}
	return { ok: false }
}

function isRoleName(value: string): value is RoleName {
	return (roleNames as ReadonlyArray<string>).includes(value)
}

function readRoleName(body: object, key: string): RoleName | null {
	const value = readNonEmptyTrimmedStringOrNumber(body, key)
	return value && isRoleName(value) ? value : null
}

function readStableUserIdField(body: object): string | null {
	const value = (body as Record<string, unknown>).stableUserId
	if (typeof value !== 'string') return null
	const stableUserId = normalizeStableUserId(value)
	return isStableUserId(stableUserId) ? stableUserId : null
}
