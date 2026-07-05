import { type Action } from 'remix/router'
import { loadAdminInvitesData } from '#app/admin-invites-data.ts'
import {
	getRequestIp,
	logAuditEvent,
	redactEmailRecipient,
} from '#app/audit-log.ts'
import {
	adminCreateUserWithPasswordSetup,
	AdminCreateUserError,
} from '#app/admin-user-creation.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import {
	createInvite,
	normalizeInviteCode,
	revokeInvite,
} from '#app/invites.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createAdminInvitesHandler(env: Env) {
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

				const action = readString(body, 'action')
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
	const email = readString(input.body, 'email') ?? ''
	const username = readString(input.body, 'username')

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
				`actor_user_id=${input.actor.userId}`,
				`target_user_id=${createdUser.userId}`,
				`target_email=${redactEmailRecipient(createdUser.email)}`,
			].join(';'),
		})

		return jsonResponse({
			...(await loadAdminInvitesData(input.env)),
			createdUser,
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
	const code = readString(input.body, 'code')
	const note = readString(input.body, 'note') ?? ''
	const maxUses = readPositiveInt(readString(input.body, 'maxUses'), 1)
	const expiresAt = readExpiresAt(input.body)
	if (expiresAt === false) {
		return jsonResponse(
			{ ok: false, error: 'Expiration must be a valid date.' },
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
		})
		const requestIp = getRequestIp(input.request) ?? undefined
		void logAuditEvent({
			category: 'admin',
			action: 'create_invite',
			result: 'success',
			email: input.actor.email,
			ip: requestIp,
			path: input.url.pathname,
			reason: `invite_code=${invite.code};max_uses=${invite.max_uses}`,
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

async function handleRevokeInviteAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	body: object
}) {
	const code = normalizeInviteCode(readString(input.body, 'code'))
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
	const value = readString(body, 'expiresAt')
	if (!value) return null
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return false
	return date.toISOString()
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
