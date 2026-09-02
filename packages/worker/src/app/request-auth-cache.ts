/**
 * Per-request auth deduplication.
 *
 * `loadSessionInfo` and `readAuthenticatedAppUser` share one D1 user + roles
 * lookup per HTTP request (a single `batch`). Live sessions also start
 * feature-flag evaluation on this cache entry so `renderAppPage` awaits an
 * already-in-flight promise. We intentionally do **not** cache auth across
 * requests keyed by session id: logout and role changes would require
 * cross-isolate invalidation that we cannot prove correct without session
 * revocation hooks on every auth mutation path.
 */

import * as Sentry from '@sentry/cloudflare'
import {
	destroyAuthCookie,
	isAuthSessionExpired,
	isSecureRequest,
	readParsedAuthSession,
} from '#app/auth-session.ts'
import {
	loadRequestFeatureFlags,
	type EvaluatedFeatureFlags,
} from '#app/request-feature-flags-cache.ts'
import { createDb, usersTable } from '#worker/db.ts'
import {
	parseUserRolesAndPermissionRows,
	type PermissionRow,
} from '#worker/identity/permissions-db.ts'
import { resolveDisplayName } from '#worker/identity/username.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import {
	parseEmailVerificationDelivery,
	type EmailVerificationDelivery,
} from '#universal/email-verification-delivery.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'

type AuthUserRow = {
	id: number
	email: string
	username: string
	avatar_key?: string | null
	email_verified_at?: string | null
	email_verification_delivery_status?: string | null
	email_verification_delivery_class?: string | null
	email_verification_delivery_at?: string | null
	deleting_at?: string | null
	suspended_at?: string | null
	password_changed_at?: string | null
	stable_user_id: string | null
}

type ResolvedAuthUser = {
	userId: number
	email: string
	emailVerified: boolean
	emailVerificationDelivery: EmailVerificationDelivery | null
	username: string
	avatarKey: string | null
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
	featureFlags: Promise<EvaluatedFeatureFlags> | null
}

const requestAuthStore = new WeakMap<Request, Promise<ResolvedRequestAuth>>()

const authUserLookupSql = `select * from "users" where ("stable_user_id" = ?)`
const authRolesLookupSql = `SELECT DISTINCT r.name AS role_name, p.action, p.entity, p.access
			 FROM user_roles ur
			 INNER JOIN roles r ON r.id = ur.role_id
			 INNER JOIN users u ON u.id = ur.user_id
			 LEFT JOIN role_permissions rp ON rp.role_id = r.id
			 LEFT JOIN permissions p ON p.id = rp.permission_id
			 WHERE u.stable_user_id = ?`

function d1ResultRows<T>(result: D1Result<T> | undefined): Array<T> {
	return result?.results ?? []
}

async function loadUserAndRoles(
	env: Env,
	stableUserId: string,
): Promise<{
	userRecord: AuthUserRow | null
	roles: Array<RoleName>
	permissions: Array<PermissionString>
}> {
	try {
		const [userResult, rolesResult] = await env.APP_DB.batch([
			env.APP_DB.prepare(authUserLookupSql).bind(stableUserId),
			env.APP_DB.prepare(authRolesLookupSql).bind(stableUserId),
		])
		const userRecord =
			d1ResultRows<AuthUserRow>(userResult as D1Result<AuthUserRow>)[0] ?? null
		let roles: Array<RoleName> = []
		let permissions: Array<PermissionString> = []
		try {
			;({ roles, permissions } = parseUserRolesAndPermissionRows(
				d1ResultRows<PermissionRow>(rolesResult as D1Result<PermissionRow>),
			))
		} catch (error) {
			console.error('Failed to load roles for authenticated user:', error)
		}
		return { userRecord, roles, permissions }
	} catch (error) {
		console.error('Failed to load roles for authenticated user:', error)
		const db = createDb(env.APP_DB)
		const userRecord = await db.findOne(usersTable, {
			where: { stable_user_id: stableUserId },
		})
		return {
			userRecord: userRecord as AuthUserRow | null,
			roles: [],
			permissions: [],
		}
	}
}

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
			featureFlags: null,
		}
	}
	const { session, issuedAt, setCookie } = parsedSession

	if (
		isAuthSessionExpired({
			issuedAt,
			rememberMe: session.rememberMe,
		})
	) {
		return {
			sessionUserId: session.stableUserId,
			setCookie: await destroyAuthCookie(isSecureRequest(request)),
			user: null,
			featureFlags: null,
		}
	}

	const { userRecord, roles, permissions } = await loadUserAndRoles(
		env,
		session.stableUserId,
	)

	if (!userRecord) {
		return {
			sessionUserId: session.stableUserId,
			setCookie: await destroyAuthCookie(isSecureRequest(request)),
			user: null,
			featureFlags: null,
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
			featureFlags: null,
		}
	}

	const stableUserId = resolveUserStableId(userRecord)
	const displayName = resolveDisplayName({
		email: userRecord.email,
		username: userRecord.username,
	})
	const accountDeleting = Boolean(userRecord.deleting_at)
	const accountSuspended = Boolean(userRecord.suspended_at)
	const featureFlags =
		accountDeleting || accountSuspended
			? null
			: loadRequestFeatureFlags(request, env, {
					userId: userRecord.id,
					stableUserId,
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
		featureFlags,
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
			avatarKey: userRecord.avatar_key ?? null,
			displayName,
			accountDeleting,
			accountSuspended,
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
 * sessions with no `issuedAt` for password-change lockout — those cookies still
 * fail the absolute session-lifetime check in `resolveRequestAuth`.
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
