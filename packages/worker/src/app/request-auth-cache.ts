/**
 * Per-request auth deduplication.
 *
 * `loadSessionInfo` and `readAuthenticatedAppUser` share one D1 user + roles
 * lookup per HTTP request. We intentionally do **not** cache auth across
 * requests keyed by session id: logout and role changes would require
 * cross-isolate invalidation that we cannot prove correct without session
 * revocation hooks on every auth mutation path.
 */

import * as Sentry from '@sentry/cloudflare'
import {
	destroyAuthCookie,
	isSecureRequest,
	readParsedAuthSession,
} from '#app/auth-session.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'
import { getUserRolesAndPermissions } from '#worker/identity/permissions-db.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import { resolveDisplayName } from '#worker/identity/username.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import {
	parseEmailVerificationDelivery,
	type EmailVerificationDelivery,
} from '#universal/email-verification-delivery.ts'

type ResolvedAuthUser = {
	userId: number
	email: string
	emailVerified: boolean
	emailVerificationDelivery: EmailVerificationDelivery | null
	username: string
	displayName: string
	accountDeleting: boolean
	accountSuspended: boolean
	roles: Array<RoleName>
	permissions: Array<PermissionString>
	mcpUser: McpUserContext
	artifactOwnerIds: Array<string>
}

export type ResolvedRequestAuth = {
	sessionUserId: string | null
	setCookie?: string | undefined
	user: ResolvedAuthUser | null
}

const requestAuthStore = new WeakMap<Request, Promise<ResolvedRequestAuth>>()

async function resolveRequestAuth(
	request: Request,
	env: Env,
): Promise<ResolvedRequestAuth> {
	const parsedSession = await readParsedAuthSession(request)
	if (!parsedSession) {
		return {
			sessionUserId: null,
			setCookie: undefined,
			user: null,
		}
	}
	const { session, issuedAt, setCookie } = parsedSession

	const db = createDb(env.APP_DB)
	const userRecord = await db.findOne(usersTable, {
		where: { stable_user_id: session.stableUserId },
	})

	if (!userRecord) {
		return {
			sessionUserId: session.stableUserId,
			setCookie: await destroyAuthCookie(isSecureRequest(request)),
			user: null,
		}
	}

	if (
		isSessionInvalidatedByStoredPasswordChange({
			issuedAt,
			storedPasswordChangedAt: userRecord.password_changed_at,
		})
	) {
		return {
			sessionUserId: session.stableUserId,
			setCookie: await destroyAuthCookie(isSecureRequest(request)),
			user: null,
		}
	}

	let roles: Array<RoleName> = []
	let permissions: Array<PermissionString> = []
	try {
		;({ roles, permissions } = await getUserRolesAndPermissions(
			env.APP_DB,
			userRecord.id,
		))
	} catch (error) {
		console.error('Failed to load roles for authenticated user:', error)
	}

	const stableUserId = resolveUserStableId(userRecord)
	const displayName = resolveDisplayName({
		email: userRecord.email,
		username: userRecord.username,
	})

	// Associate uncaught request errors with the signed-in user in Sentry.
	// Id only: sendDefaultPii is false and emails stay out of Sentry. Must
	// never break auth resolution.
	try {
		if (Sentry.isInitialized()) Sentry.setUser({ id: stableUserId })
	} catch {
		// Observability must not affect auth.
	}

	return {
		sessionUserId: session.stableUserId,
		setCookie: setCookie ?? undefined,
		user: {
			userId: userRecord.id,
			email: userRecord.email,
			emailVerified: Boolean(userRecord.email_verified_at),
			emailVerificationDelivery: parseEmailVerificationDelivery({
				status: userRecord.email_verification_delivery_status,
				class: userRecord.email_verification_delivery_class,
				at: userRecord.email_verification_delivery_at,
			}),
			username: userRecord.username,
			displayName,
			accountDeleting: Boolean(userRecord.deleting_at),
			accountSuspended: Boolean(userRecord.suspended_at),
			roles,
			permissions,
			mcpUser: {
				userId: stableUserId,
				email: userRecord.email,
				username: userRecord.username,
				displayName,
			},
			artifactOwnerIds: [stableUserId],
		},
	}
}

/**
 * Parse a stored password_changed_at / SQLite-style timestamp to epoch ms.
 * Whole-second timestamps (no fractional seconds) are treated as the end of
 * that second so cookies issued later in the same second cannot survive a
 * reset that only recorded second precision.
 */
export { parsePasswordChangedAtMs } from '#worker/password-change-lockout.ts'

/**
 * True when a session predates the account's stored `password_changed_at`.
 *
 * Every session flavor (browser `kody_session`, package-app `kody_pkg_session`,
 * and MCP access tokens) must share this decision, so a password reset can
 * never revoke one and leave another alive.
 *
 * Fail-closed behavior is scoped to accounts that have a stored timestamp: a
 * value that exists but cannot be parsed invalidates the session, and so does a
 * missing `issuedAt`. An account that has never changed its password keeps
 * sessions with no `issuedAt` — those cookies stay valid until a password
 * change, which is the documented tradeoff in the "Accepted residual risks"
 * section of `docs/contributing/security.md`.
 */
export function isSessionInvalidatedByStoredPasswordChange(input: {
	issuedAt: number | undefined
	storedPasswordChangedAt: string | null | undefined
}): boolean {
	return isCredentialInvalidatedByStoredPasswordChange({
		issuedAtMs: input.issuedAt,
		storedPasswordChangedAt: input.storedPasswordChangedAt,
	})
}

export function loadResolvedRequestAuth(
	request: Request,
	env: Env,
): Promise<ResolvedRequestAuth> {
	let promise = requestAuthStore.get(request)
	if (!promise) {
		promise = resolveRequestAuth(request, env)
		requestAuthStore.set(request, promise)
	}
	return promise
}
