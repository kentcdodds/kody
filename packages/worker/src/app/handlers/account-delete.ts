import { type Action } from 'remix/router'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUserForDeletion } from '#app/authenticated-user.ts'
import { destroyAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { isAccountDeletionConfirmation } from '#universal/account-deletion-confirmation.ts'
import { type routes } from '#universal/routes.ts'
import {
	UserDeleteBlockedSoleOwnerError,
	softDeleteUserAccount,
} from '#worker/orgs/soft-delete.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { scheduleUserDeletedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import { isUsablePasswordHash } from '#worker/identity/usable-password.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'

function readDeleteRequestFields(body: unknown) {
	if (!body || typeof body !== 'object') {
		return { confirmation: null, password: null }
	}
	const record = body as Record<string, unknown>
	return {
		confirmation:
			typeof record.confirmation === 'string' ? record.confirmation : null,
		password: typeof record.password === 'string' ? record.password : null,
	}
}

export function createAccountDeleteHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const requestIp = getRequestIp(request) ?? undefined
			const user = await readAuthenticatedAppUserForDeletion(request, env)
			if (!user) {
				return Response.json(
					{ error: 'Authentication required.' },
					{ status: 401 },
				)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return Response.json(
					{ error: 'Invalid JSON payload.' },
					{ status: 400 },
				)
			}

			const { confirmation, password } = readDeleteRequestFields(body)
			if (!confirmation || !isAccountDeletionConfirmation(confirmation)) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'account_delete',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'invalid_confirmation',
				})
				return Response.json(
					{
						error: 'Account deletion requires typing GOODBYE KODY to confirm.',
					},
					{ status: 400 },
				)
			}

			const db = createDb(env.APP_DB)
			const userRow = await db.findOne(usersTable, {
				where: { id: user.userId },
			})
			if (!userRow) {
				return Response.json({ error: 'User not found.' }, { status: 404 })
			}

			if (isUsablePasswordHash(userRow.password_hash)) {
				if (!password) {
					return Response.json(
						{
							error:
								'Account deletion requires re-entering the current password.',
						},
						{ status: 400 },
					)
				}
				const passwordValid = await verifyPassword(
					password,
					userRow.password_hash,
				)
				if (!passwordValid) {
					void logAuditEvent({
						db: auditDatabaseFromEnv(env),
						category: 'auth',
						action: 'account_delete',
						result: 'failure',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: 'invalid_password',
					})
					return Response.json(
						{ error: 'Current password did not match.' },
						{ status: 401 },
					)
				}
			}

			let result: Awaited<ReturnType<typeof softDeleteUserAccount>>
			try {
				result = await softDeleteUserAccount({
					env,
					userId: user.mcpUser.userId,
					actorUserId: user.mcpUser.userId,
					actorUsername: user.username,
				})
			} catch (error) {
				if (error instanceof UserDeleteBlockedSoleOwnerError) {
					void logAuditEvent({
						db: auditDatabaseFromEnv(env),
						category: 'auth',
						action: 'account_delete',
						result: 'failure',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: 'sole_owner_with_members',
					})
					const orgList = error.blockers
						.map((blocker) => `@${blocker.orgSlug}`)
						.join(', ')
					return Response.json(
						{
							error: `Account deletion is blocked while you are the only Owner of ${orgList}. Promote another Owner or remove the other members first.`,
							blockers: error.blockers,
						},
						{ status: 409 },
					)
				}
				throw error
			}

			scheduleUserDeletedEvent({
				env,
				user: {
					id: user.mcpUser.userId,
					username: user.username,
					email: user.email,
				},
			})

			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'account_delete',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: 'soft_deleted',
			})

			const headers = new Headers({ 'Content-Type': 'application/json' })
			headers.set(
				'Set-Cookie',
				await destroyAuthCookie(isSecureRequest(request)),
			)

			return new Response(
				JSON.stringify({
					ok: true,
					softDeleted: true,
					restoreWindowDays: 30,
					...result,
				}),
				{ status: 200, headers },
			)
		},
	} satisfies Action<typeof routes.accountDelete>
}
