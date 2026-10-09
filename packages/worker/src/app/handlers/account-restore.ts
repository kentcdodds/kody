import { type Action } from 'remix/router'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	createAuthCookie,
	destroyAuthCookie,
	isSecureRequest,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import {
	destroyAccountRestoreCookie,
	readAccountRestoreProof,
	readSoftDeletedSignIn,
	readTombstonedUserByEmail,
	setAccountRestoreSecret,
} from '#app/account-restore.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { reconcileSignupWelcomeCreditsIfPending } from '#worker/billing/signup-welcome-credits.ts'
import { touchLastActiveAt } from '#worker/identity/activation-stamps.ts'
import { softDeleteRetentionDays } from '#universal/soft-delete-retention.ts'
import { type routes } from '#universal/routes.ts'
import {
	OrgRestoreWindowExpiredError,
	restoreUserAccount,
} from '#worker/orgs/soft-delete.ts'

function readIntent(body: unknown): 'restore' | 'decline' | null {
	if (!body || typeof body !== 'object') return null
	const intent = (body as Record<string, unknown>).intent
	if (intent === 'restore' || intent === 'decline') return intent
	return null
}

export function createAccountRestoreHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			setAuthSessionSecret(env.COOKIE_SECRET)
			setAccountRestoreSecret(env.COOKIE_SECRET)
			const secure = isSecureRequest(request)
			const requestIp = getRequestIp(request) ?? undefined

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return Response.json(
					{ error: 'Invalid JSON payload.' },
					{ status: 400 },
				)
			}
			const intent = readIntent(body)
			if (!intent) {
				return Response.json(
					{ error: 'Choose whether to restore this account.' },
					{ status: 400 },
				)
			}

			const clearRestore = await destroyAccountRestoreCookie(secure)
			if (intent === 'decline') {
				const proof = await readAccountRestoreProof(request)
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'account_restore',
					result: 'success',
					email: proof?.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'declined',
				})
				return Response.json(
					{ ok: true, declined: true },
					{ headers: { 'Set-Cookie': clearRestore } },
				)
			}

			const proof = await readAccountRestoreProof(request)
			if (!proof) {
				return Response.json(
					{ error: 'Sign in again to restore this account.' },
					{ status: 401, headers: { 'Set-Cookie': clearRestore } },
				)
			}

			const row = await readTombstonedUserByEmail(env.APP_DB, proof.email)
			const stableUserId = row?.stable_user_id
				? personIdFromStored(row.stable_user_id)
				: null
			if (!row || !stableUserId || stableUserId !== proof.stableUserId) {
				return Response.json(
					{ error: 'Sign in again to restore this account.' },
					{ status: 401, headers: { 'Set-Cookie': clearRestore } },
				)
			}

			const signIn = await readSoftDeletedSignIn(env.APP_DB, proof.email)
			switch (signIn.kind) {
				case 'live':
					return Response.json(
						{ error: 'This account is not waiting to be restored.' },
						{ status: 409, headers: { 'Set-Cookie': clearRestore } },
					)
				case 'expired':
					void logAuditEvent({
						db: auditDatabaseFromEnv(env),
						category: 'auth',
						action: 'account_restore',
						result: 'failure',
						email: proof.email,
						ip: requestIp,
						path: url.pathname,
						reason: 'restore_window_expired',
					})
					return Response.json(
						{ error: 'This account can no longer be restored.' },
						{ status: 401, headers: { 'Set-Cookie': clearRestore } },
					)
				case 'restore':
					break
				default: {
					const unreachable: never = signIn
					throw new Error(`Unhandled restore state: ${String(unreachable)}`)
				}
			}

			try {
				await restoreUserAccount({
					env,
					userId: proof.stableUserId,
					actorUserId: proof.stableUserId,
					actorUsername: row.username,
				})
			} catch (error) {
				if (error instanceof OrgRestoreWindowExpiredError) {
					return Response.json(
						{ error: 'This account can no longer be restored.' },
						{ status: 401, headers: { 'Set-Cookie': clearRestore } },
					)
				}
				throw error
			}

			const headers = new Headers({ 'Content-Type': 'application/json' })
			headers.append('Set-Cookie', clearRestore)
			headers.append('Set-Cookie', await destroyAuthCookie(secure))

			if (await isTwoFactorEnabled(env.APP_DB, row.id)) {
				setVerifySessionSecret(env.COOKIE_SECRET)
				headers.append(
					'Set-Cookie',
					await createVerifySessionCookie(
						{
							stableUserId: proof.stableUserId,
							email: proof.email,
							rememberMe: proof.rememberMe,
						},
						secure,
					),
				)
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'account_restore',
					result: 'success',
					email: proof.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'restored_2fa_challenge',
				})
				return new Response(
					JSON.stringify({
						ok: true,
						restored: true,
						requiresTwoFactor: true,
						restoreWindowDays: softDeleteRetentionDays,
					}),
					{ status: 200, headers },
				)
			}

			headers.append(
				'Set-Cookie',
				await createAuthCookie(
					{
						stableUserId: proof.stableUserId,
						email: proof.email,
						rememberMe: proof.rememberMe,
					},
					secure,
				),
			)
			await touchLastActiveAt(env.APP_DB, { stableUserId: proof.stableUserId })
			await reconcileSignupWelcomeCreditsIfPending({
				db: env.APP_DB,
				userId: proof.stableUserId,
			})
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'account_restore',
				result: 'success',
				email: proof.email,
				ip: requestIp,
				path: url.pathname,
				reason: 'restored',
			})
			return new Response(
				JSON.stringify({
					ok: true,
					restored: true,
					restoreWindowDays: softDeleteRetentionDays,
				}),
				{ status: 200, headers },
			)
		},
	} satisfies Action<typeof routes.authRestoreAccount>
}
