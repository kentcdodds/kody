import { type BuildAction } from 'remix/fetch-router'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { destroyAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { type routes } from '#app/routes.ts'
import { deleteUserAccount } from '#app/account-deletion.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'

export function createAccountDeleteHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const requestIp = getRequestIp(request) ?? undefined
			const user = await readAuthenticatedAppUser(request, env)
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

			const result = await deleteUserAccount({
				env,
				dbUserId: user.userId,
				mcpUserId: user.mcpUser.userId,
			})

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
	} satisfies BuildAction<
		typeof routes.accountDelete.method,
		typeof routes.accountDelete.pattern
	>
}
