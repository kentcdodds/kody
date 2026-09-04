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
	AccountDeletionBillingError,
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
	deleteUserAccount,
} from '#app/account-deletion.ts'
import { AccountDeletionWritersActiveError } from '#worker/account/deletion-state.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { scheduleUserDeletedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import { isUsablePasswordHash } from '#worker/identity/usable-password.ts'
import { formatStripeMinorAmount } from '#worker/billing/minor-amount.ts'
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

type AccountDeletionFailure =
	| AccountDeletionInventoryError
	| AccountDeletionBillingError
	| AccountDeletionCleanupError
	| AccountDeletionWritersActiveError

function accountDeletionFailureReason(error: AccountDeletionFailure) {
	if (error instanceof AccountDeletionWritersActiveError)
		return 'writers_active'
	if (error instanceof AccountDeletionInventoryError) {
		return 'inventory_incomplete'
	}
	if (error instanceof AccountDeletionBillingError) {
		return 'billing_cancel_failed'
	}
	return 'cleanup_incomplete'
}

function accountDeletionFailureMessage(error: AccountDeletionFailure) {
	if (error instanceof AccountDeletionBillingError) {
		return 'We could not refund and cancel your subscription, so your account was not deleted. Try again in a few minutes or contact support.'
	}
	return 'Account deletion could not complete safely. Try again later.'
}

/**
 * Display-ready refund summary for the deletion panel. Keeps the raw
 * `stripeRefunds` entries in the response too for operators; this is the
 * human-readable line the UI shows.
 */
function summarizeRefunds(
	refunds: Awaited<ReturnType<typeof deleteUserAccount>>['stripeRefunds'],
) {
	if (refunds.length === 0) return {}
	return {
		refunds: refunds.map((refund) => ({
			amount: formatStripeMinorAmount(refund.amountMinor, refund.currency),
			currency: refund.currency.toUpperCase(),
		})),
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
						error instanceof AccountDeletionBillingError ||
						error instanceof AccountDeletionCleanupError ||
						error instanceof AccountDeletionWritersActiveError
					)
				) {
					throw error
				}
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'account_delete',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: accountDeletionFailureReason(error),
				})
				return Response.json(
					{ error: accountDeletionFailureMessage(error) },
					{ status: 503 },
				)
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
					...summarizeRefunds(result.stripeRefunds ?? []),
				}),
				{ status: 200, headers },
			)
		},
	} satisfies Action<typeof routes.accountDelete>
}
