import {
	readAuthSessionResult,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { getUserRolesAndPermissions } from '#app/permissions-db.ts'
import { type PermissionString, type RoleName } from '#app/permissions.ts'
import { getUsernameValidationError } from '#app/username.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'

export type AuthenticatedAppUser = {
	sessionUserId: string
	userId: number
	username: string
	email: string
	displayName: string
	roles: Array<RoleName>
	permissions: Array<PermissionString>
	mcpUser: McpUserContext
	artifactOwnerIds: Array<string>
}

function buildDisplayName(email: string) {
	return email.split('@')[0] || 'user'
}

function getDisplayName(input: { email: string; username: string }) {
	return getUsernameValidationError(input.username)
		? buildDisplayName(input.email)
		: input.username
}

export async function readAuthenticatedAppUser(request: Request, env: Env) {
	setAuthSessionSecret(env.COOKIE_SECRET)
	const { session } = await readAuthSessionResult(request)
	if (!session) return null

	const userId = /^\d+$/.test(session.id) ? Number(session.id) : NaN
	if (!Number.isSafeInteger(userId) || userId <= 0) return null

	const db = createDb(env.APP_DB)
	const userRecord = await db.findOne(usersTable, {
		where: { id: userId },
	})
	if (!userRecord) return null

	const emailBasedUserId = await createStableUserIdFromEmail(userRecord.email)
	const displayName = getDisplayName({
		email: userRecord.email,
		username: userRecord.username,
	})
	// A transient failure of the roles query must not break authentication
	// entirely. Falling back to empty roles fails closed: the user stays
	// signed in but holds no permissions until the lookup recovers.
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

	return {
		sessionUserId: session.id,
		userId,
		username: userRecord.username,
		email: userRecord.email,
		displayName,
		roles,
		permissions,
		artifactOwnerIds: Array.from(
			new Set([session.id, emailBasedUserId].filter(Boolean)),
		),
		mcpUser: {
			userId: emailBasedUserId,
			email: userRecord.email,
			username: userRecord.username,
			displayName,
		},
	} satisfies AuthenticatedAppUser
}
