import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import {
	loadRequestFeatureFlags,
	type EvaluatedFeatureFlags,
} from '#app/request-feature-flags-cache.ts'
import { type PermissionString, type RoleName } from '#app/permissions.ts'

export type SessionInfo = {
	email: string
	emailVerified: boolean
	username: string
	roles: Array<RoleName>
	permissions: Array<PermissionString>
	featureFlags: EvaluatedFeatureFlags
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
	// A suspended account's session is treated as signed out everywhere,
	// including the SSR shell (matching readAuthenticatedAppUser).
	if (!resolved.user || resolved.user.accountSuspended) {
		return {
			session: null,
			setCookie: resolved.setCookie,
		}
	}

	const featureFlags = await loadRequestFeatureFlags(
		request,
		env,
		resolved.user.userId,
	)

	return {
		session: {
			email: resolved.user.email,
			emailVerified: resolved.user.emailVerified,
			username: resolved.user.username,
			roles: resolved.user.roles,
			permissions: resolved.user.permissions,
			featureFlags,
		},
		setCookie: resolved.setCookie,
	}
}
