import { setAuthSessionSecret } from '#app/auth-session.ts'
import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import { type PermissionString, type RoleName } from '#app/permissions.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'

export type AuthenticatedAppUser = {
	sessionUserId: string
	userId: number
	username: string
	email: string
	emailVerified: boolean
	displayName: string
	roles: Array<RoleName>
	permissions: Array<PermissionString>
	mcpUser: McpUserContext
	artifactOwnerIds: Array<string>
}

async function readAuthenticatedAppUserInternal(
	request: Request,
	env: Env,
	allowDeleting: boolean,
) {
	setAuthSessionSecret(env.COOKIE_SECRET)
	const resolved = await loadResolvedRequestAuth(request, env)
	if (!resolved.user || !resolved.sessionUserId) return null
	if (resolved.user.accountDeleting && !allowDeleting) return null
	// Suspension is a platform kill switch: no surface honors a suspended
	// session, so every consumer of this helper fails closed.
	if (resolved.user.accountSuspended) return null

	return {
		sessionUserId: resolved.sessionUserId,
		userId: resolved.user.userId,
		username: resolved.user.username,
		email: resolved.user.email,
		emailVerified: resolved.user.emailVerified,
		displayName: resolved.user.displayName,
		roles: resolved.user.roles,
		permissions: resolved.user.permissions,
		artifactOwnerIds: resolved.user.artifactOwnerIds,
		mcpUser: resolved.user.mcpUser,
	} satisfies AuthenticatedAppUser
}

export async function readAuthenticatedAppUser(request: Request, env: Env) {
	return await readAuthenticatedAppUserInternal(request, env, false)
}

export async function readAuthenticatedAppUserForDeletion(
	request: Request,
	env: Env,
) {
	return await readAuthenticatedAppUserInternal(request, env, true)
}
