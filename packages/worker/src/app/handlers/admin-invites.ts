import { readPositiveInt } from '#worker/query-params.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAdminInvitesData } from '#app/admin-invites-data.ts'
import {
	getRequestIp,
	logAuditEvent,
	redactEmailRecipient,
} from '#worker/audit-log.ts'
import {
	adminCreateUserWithPasswordSetup,
	AdminCreateUserError,
} from '#worker/identity/admin-user-creation.ts'
import {
	createInvite,
	normalizeInviteCode,
	revokeInvite,
} from '#app/invites.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { readNonEmptyTrimmedStringOrNumber } from '#app/request-body.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import {
	parsePlanName,
	resolvePlanWrite,
	type PlanName,
} from '#universal/plans.ts'

export function createAdminInvitesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}

			const adminInvites = await loadAdminInvitesData(env)

			return renderAppPage({
				request,
				env,
				title: 'Admin invites',
				loaderData: { adminInvites },
			})
		},
	} satisfies Action<typeof routes.adminInvites>
}

export function createAdminInvitesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
				if (request.method === 'GET') {
					await requireUserWithRole(request, env, 'admin')
					const payload = await loadAdminInvitesData(env)
					return jsonResponse(payload)
				}

				if (request.method !== 'POST') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}

				const actor = await requireUserWithRole(request, env, 'admin')
				const body = await request.json().catch(() => null)
				if (!body || typeof body !== 'object') {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}

				const action = readNonEmptyTrimmedStringOrNumber(body, 'action')
				if (action === 'create_invite') {
					return handleCreateInviteAction({ env, request, url, actor, body })
				}
				if (action === 'revoke_invite') {
					return handleRevokeInviteAction({ env, request, url, actor, body })
				}
				if (action === 'create_user') {
					return handleCreateUserAction({ env, request, url, actor, body })
				}

				return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminInvitesApi>
}

async function handleCreateUserAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	body: object
}) {
	const email = readNonEmptyTrimmedStringOrNumber(input.body, 'email') ?? ''
	const username = readNonEmptyTrimmedStringOrNumber(input.body, 'username')

	try {
		const createdUser = await adminCreateUserWithPasswordSetup({
			db: input.env.APP_DB,
			email,
			username,
			setupLinkOrigin: input.url,
		})
		const requestIp = getRequestIp(input.request) ?? undefined
		void logAuditEvent({
			category: 'admin',
			action: 'create_user',
			result: 'success',
			email: input.actor.email,
			ip: requestIp,
			path: input.url.pathname,
			reason: [
				`actor_stable_user_id=${input.actor.mcpUser.userId}`,
				`target_stable_user_id=${createdUser.stableUserId}`,
				`target_email=${redactEmailRecipient(createdUser.email)}`,
			].join(';'),
		})

		const { userId: _userId, ...boundaryUser } = createdUser
		return jsonResponse({
			...(await loadAdminInvitesData(input.env)),
			createdUser: boundaryUser,
		})
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Unable to create user.'
		return jsonResponse(
			{
				ok: false,
				error: message,
				code: error instanceof AdminCreateUserError ? error.code : undefined,
			},
			error instanceof AdminCreateUserError &&
				(error.code === 'email_exists' || error.code === 'username_exists')
				? 409
				: error instanceof AdminCreateUserError
					? 400
					: 500,
		)
	}
}

async function handleCreateInviteAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	body: object
}) {
	const code = readNonEmptyTrimmedStringOrNumber(input.body, 'code')
	const note = readNonEmptyTrimmedStringOrNumber(input.body, 'note') ?? ''
	const maxUses = readPositiveInt(
		readNonEmptyTrimmedStringOrNumber(input.body, 'maxUses'),
		1,
	)
	const expiresAt = readExpiresAt(input.body)
	if (expiresAt === false) {
		return jsonResponse(
			{ ok: false, error: 'Expiration must be a valid date.' },
			400,
		)
	}
	const planResult = readInvitePlan(input.body)
	if (!planResult.ok) {
		return jsonResponse(
			{
				ok: false,
				error: 'Plan must be one of the known plan names, or empty for free.',
			},
			400,
		)
	}

	try {
		const invite = await createInvite({
			db: input.env.APP_DB,
			code,
			createdBy: input.actor.userId,
			note,
			maxUses,
			expiresAt,
			plan: planResult.plan,
		})
		const requestIp = getRequestIp(input.request) ?? undefined
		void logAuditEvent({
			category: 'admin',
			action: 'create_invite',
			result: 'success',
			email: input.actor.email,
			ip: requestIp,
			path: input.url.pathname,
			reason: `invite_code=${invite.code};max_uses=${invite.max_uses};plan=${planResult.plan}`,
		})
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error ? error.message : 'Unable to create invite.',
			},
			400,
		)
	}

	return jsonResponse(await loadAdminInvitesData(input.env))
}

/**
 * Read an optional invite plan: missing/empty/null → `free`.
 * Unknown non-empty values are rejected. Writers never persist NULL.
 */
function readInvitePlan(
	body: object,
): { ok: true; plan: PlanName } | { ok: false } {
	if (!('plan' in body)) return { ok: true, plan: resolvePlanWrite(null) }
	const value = (body as Record<string, unknown>).plan
	if (value === null || value === undefined) {
		return { ok: true, plan: resolvePlanWrite(null) }
	}
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (!trimmed) return { ok: true, plan: resolvePlanWrite(null) }
		const plan = parsePlanName(trimmed)
		if (plan) return { ok: true, plan }
	}
	return { ok: false }
}

async function handleRevokeInviteAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	body: object
}) {
	const code = normalizeInviteCode(
		readNonEmptyTrimmedStringOrNumber(input.body, 'code'),
	)
	if (!code) {
		return jsonResponse({ ok: false, error: 'Invite code is required.' }, 400)
	}
	const revoked = await revokeInvite({ db: input.env.APP_DB, code })
	if (!revoked) {
		return jsonResponse({ ok: false, error: 'Invite not found.' }, 404)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		category: 'admin',
		action: 'revoke_invite',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `invite_code=${code}`,
	})

	return jsonResponse(await loadAdminInvitesData(input.env))
}

function readExpiresAt(body: object): string | null | false {
	const value = readNonEmptyTrimmedStringOrNumber(body, 'expiresAt')
	if (!value) return null
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return false
	return date.toISOString()
}
