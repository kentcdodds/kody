import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import { readAuthenticatedAppUserForDeletion } from '#app/authenticated-user.ts'
import { destroyAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { type routes } from '#app/routes.ts'
import {
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
	deleteUserAccount,
} from '#app/account-deletion.ts'
import { AccountDeletionWritersActiveError } from '#worker/account/deletion-state.ts'
import { McpAgentSessionBackfillIncompleteError } from '#mcp/session-backfill-marker.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'

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

			const password =
				body && typeof body === 'object'
					? (body as Record<string, unknown>).password
					: undefined
			if (typeof password !== 'string' || password.length === 0) {
				return Response.json(
					{
						error:
							'Account deletion requires re-entering the current password.',
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
			const passwordValid = await verifyPassword(
				password,
				userRow.password_hash,
			)
			if (!passwordValid) {
				void logAuditEvent({
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

			let result: Awaited<ReturnType<typeof deleteUserAccount>>
			try {
				result = await deleteUserAccount({
					env,
					dbUserId: user.userId,
					mcpUserId: user.mcpUser.userId,
				})
			} catch (error) {
				if (
					!(
						error instanceof AccountDeletionInventoryError ||
						error instanceof AccountDeletionCleanupError ||
						error instanceof AccountDeletionWritersActiveError ||
						error instanceof McpAgentSessionBackfillIncompleteError
					)
				) {
					throw error
				}
				void logAuditEvent({
					category: 'auth',
					action: 'account_delete',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason:
						error instanceof McpAgentSessionBackfillIncompleteError
							? 'mcp_agent_session_backfill_incomplete'
							: error instanceof AccountDeletionWritersActiveError
								? 'writers_active'
								: error instanceof AccountDeletionInventoryError
									? 'inventory_incomplete'
									: 'cleanup_incomplete',
				})
				return Response.json(
					{
						error:
							'Account deletion could not complete safely. Try again later.',
					},
					{ status: 503 },
				)
			}

			void logAuditEvent({
				category: 'auth',
				action: 'account_delete',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
			})

			const headers = new Headers({ 'Content-Type': 'application/json' })
			headers.set(
				'Set-Cookie',
				await destroyAuthCookie(isSecureRequest(request)),
			)

			return new Response(
				JSON.stringify({
					ok: true,
					...result,
				}),
				{ status: 200, headers },
			)
		},
	} satisfies Action<typeof routes.accountDelete>
}
