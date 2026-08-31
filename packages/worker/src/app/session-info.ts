import { destroyAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import {
	loadRequestFeatureFlags,
	type EvaluatedFeatureFlags,
} from '#app/request-feature-flags-cache.ts'
import { type EmailVerificationDelivery } from '#universal/email-verification-delivery.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'

export type SessionInfo = {
	email: string
	emailVerified: boolean
	emailVerificationDelivery: EmailVerificationDelivery | null
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
	// Suspended and deleting accounts are signed out in the SSR shell
	// (matching readAuthenticatedAppUser). Deleting also clears the cookie
	// so /login does not bounce back to /account.
	if (
		!resolved.user ||
		resolved.user.accountSuspended ||
		resolved.user.accountDeleting
	) {
		return {
			session: null,
			setCookie: resolved.user?.accountDeleting
				? await destroyAuthCookie(isSecureRequest(request))
				: resolved.setCookie,
		}
	}

	const featureFlags = await loadRequestFeatureFlags(request, env, {
		userId: resolved.user.userId,
		stableUserId: resolved.user.mcpUser.userId,
	})

	return {
		session: {
			email: resolved.user.email,
			emailVerified: resolved.user.emailVerified,
			emailVerificationDelivery: resolved.user.emailVerificationDelivery,
			username: resolved.user.username,
			roles: resolved.user.roles,
			permissions: resolved.user.permissions,
			featureFlags,
		},
		setCookie: resolved.setCookie,
	}
}
