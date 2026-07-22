/**
 * Per-request auth deduplication.
 *
 * `loadSessionInfo` and `readAuthenticatedAppUser` share one D1 user + roles
 * lookup per HTTP request. We intentionally do **not** cache auth across
 * requests keyed by session id: logout and role changes would require
 * cross-isolate invalidation that we cannot prove correct without session
 * revocation hooks on every auth mutation path.
 */

import {
	destroyAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
} from '#app/auth-session.ts'
import { getUserRolesAndPermissions } from '#app/permissions-db.ts'
import { type PermissionString, type RoleName } from '#app/permissions.ts'
import {
	displayNameFromEmail,
	getUsernameFormatValidationError,
} from '#app/username.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'

type ResolvedAuthUser = {
	userId: number
	email: string
	emailVerified: boolean
	username: string
	displayName: string
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
	const { session, setCookie } = await readAuthSessionResult(request)
	if (!session) {
		return {
			sessionUserId: null,
			setCookie: setCookie ?? undefined,
			user: null,
		}
	}

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

	return {
		sessionUserId: session.id,
		setCookie: setCookie ?? undefined,
		user: {
			userId,
			email: userRecord.email,
			emailVerified: Boolean(userRecord.email_verified_at),
			username: userRecord.username,
			displayName,
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
