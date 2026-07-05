import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'

import { type PermissionString, type RoleName } from '#app/permissions.ts'

export type SessionInfo = {
	email: string
	emailVerified: boolean
	username: string
	roles: Array<RoleName>
	permissions: Array<PermissionString>
}

export type LoadedSessionResult = {
	session: SessionInfo | null
	setCookie?: string | undefined
}

export async function loadSessionInfo(
	request: Request,
	env: Env,
): Promise<LoadedSessionResult> {
	const resolved = await loadResolvedRequestAuth(request, env)
	if (!resolved.user) {
		return {
			session: null,
			setCookie: resolved.setCookie,
		}
	}

	return {
		session: {
			email: resolved.user.email,
			emailVerified: resolved.user.emailVerified,
			username: resolved.user.username,
			roles: resolved.user.roles,
			permissions: resolved.user.permissions,
		},
		setCookie: resolved.setCookie,
	}
}
