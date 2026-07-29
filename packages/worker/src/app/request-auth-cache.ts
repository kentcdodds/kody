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
	isAuthSessionInvalidatedByPasswordChange,
	isSecureRequest,
	readParsedAuthSession,
} from '#app/auth-session.ts'
import { getUserRolesAndPermissions } from '#worker/identity/permissions-db.ts'
import {
	type PermissionString,
	type RoleName,
} from '#worker/identity/permissions.ts'
import {
	displayNameFromEmail,
	getUsernameFormatValidationError,
} from '#worker/identity/username.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'

type ResolvedAuthUser = {
	userId: number
	email: string
	emailVerified: boolean
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

function getDisplayName(input: { email: string; username: string }) {
	return getUsernameFormatValidationError(input.username)
		? displayNameFromEmail(input.email)
		: input.username
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
		}
	}
	const { session, issuedAt, setCookie } = parsedSession

	const userId = /^\d+$/.test(session.id) ? Number(session.id) : NaN
	const db = createDb(env.APP_DB)
	const userRecord =
		Number.isSafeInteger(userId) && userId > 0
			? await db.findOne(usersTable, { where: { id: userId } })
			: null

	if (!userRecord) {
		return {
			sessionUserId: session.id,
			setCookie: await destroyAuthCookie(isSecureRequest(request)),
			user: null,
		}
	}

	const passwordChangedAtRaw = userRecord.password_changed_at?.trim() ?? ''
	const passwordChangedAtMs = parsePasswordChangedAtMs(passwordChangedAtRaw)
	// Non-empty but unparseable must fail closed — do not treat as "never changed".
	if (
		(passwordChangedAtRaw !== '' && passwordChangedAtMs === null) ||
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt,
			passwordChangedAtMs,
		})
	) {
		return {
			sessionUserId: session.id,
			setCookie: await destroyAuthCookie(isSecureRequest(request)),
			user: null,
		}
	}

	let roles: Array<RoleName> = []
	let permissions: Array<PermissionString> = []
	try {
		;({ roles, permissions } = await getUserRolesAndPermissions(
			env.APP_DB,
			userId,
		))
	} catch (error) {
		console.error('Failed to load roles for authenticated user:', error)
	}

	const stableUserId = resolveUserStableId(userRecord)
	const displayName = getDisplayName({
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
		sessionUserId: session.id,
		setCookie: setCookie ?? undefined,
		user: {
			userId,
			email: userRecord.email,
			emailVerified: Boolean(userRecord.email_verified_at),
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
			artifactOwnerIds: Array.from(
				new Set([session.id, stableUserId].filter(Boolean)),
			),
		},
	}
}

/**
 * Parse a stored password_changed_at / SQLite-style timestamp to epoch ms.
 * Whole-second timestamps (no fractional seconds) are treated as the end of
 * that second so cookies issued later in the same second cannot survive a
 * reset that only recorded second precision.
 */
export function parsePasswordChangedAtMs(value: string | null | undefined) {
	if (!value) return null
	const trimmed = value.trim()
	if (!trimmed) return null
	const normalized = trimmed.includes('T')
		? trimmed
		: `${trimmed.replace(' ', 'T')}Z`
	const ms = Date.parse(normalized)
	if (!Number.isFinite(ms)) return null
	const hasFractionalSeconds = /(?:[T ])\d{2}:\d{2}:\d{2}\.\d/.test(normalized)
	return hasFractionalSeconds ? ms : ms + 999
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
