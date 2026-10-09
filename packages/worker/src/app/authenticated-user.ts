import { setAuthSessionSecret } from '#app/auth-session.ts'
import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import { prefetchRequestFeatureFlagsForHtmlPage } from '#app/request-feature-flags-cache.ts'
import { type EmailVerificationDelivery } from '#universal/email-verification-delivery.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { loadOrgBindingForPerson } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'

export type AuthenticatedAppUser = {
	sessionUserId: string
	userId: number
	username: string
	email: string
	emailVerified: boolean
	emailVerificationDelivery: EmailVerificationDelivery | null
	displayName: string
	roles: Array<RoleName>
	permissions: Array<PermissionString>
	mcpUser: McpUserContext
	artifactOwnerIds: Array<string>
	/** Who is acting, in which org, through this session. */
	request: RequestContext
}

export type ReadAuthenticatedAppUserOptions = {
	prefetchFeatureFlags?: boolean
}

async function readAuthenticatedAppUserInternal(
	request: Request,
	env: Env,
	allowDeleting: boolean,
	prefetchFeatureFlags: boolean,
) {
	setAuthSessionSecret(env.COOKIE_SECRET)
	const resolved = await loadResolvedRequestAuth(request, env)
	if (!resolved.user || !resolved.sessionUserId) return null
	if (resolved.user.accountDeleting && !allowDeleting) return null
	// Suspension is a platform kill switch: no surface honors a suspended
	// session, so every consumer of this helper fails closed.
	if (resolved.user.accountSuspended) return null

	const resolution = await loadRequestOrgResolution(
		request,
		env,
		resolved.user.mcpUser.userId,
	)
	const orgBinding =
		resolution === 'personal' || resolution === 'denied'
			? await loadOrgBindingForPerson(env.APP_DB, resolved.user.mcpUser.userId)
			: resolution
	const user = {
		sessionUserId: resolved.sessionUserId,
		userId: resolved.user.userId,
		username: resolved.user.username,
		email: resolved.user.email,
		emailVerified: resolved.user.emailVerified,
		emailVerificationDelivery: resolved.user.emailVerificationDelivery,
		displayName: resolved.user.displayName,
		roles: resolved.user.roles,
		permissions: resolved.user.permissions,
		artifactOwnerIds: resolved.user.artifactOwnerIds,
		mcpUser: resolved.user.mcpUser,
		request: deriveRequestContext({
			user: resolved.user.mcpUser,
			source: { kind: 'session' },
			orgBinding,
		}),
	} satisfies AuthenticatedAppUser
	if (prefetchFeatureFlags) {
		prefetchRequestFeatureFlagsForHtmlPage(request, env, {
			userId: user.userId,
			stableUserId: user.mcpUser.userId,
		})
	}
	return user
}

export async function readAuthenticatedAppUser(
	request: Request,
	env: Env,
	options?: ReadAuthenticatedAppUserOptions,
) {
	return await readAuthenticatedAppUserInternal(
		request,
		env,
		false,
		options?.prefetchFeatureFlags === true,
	)
}

export async function readAuthenticatedAppUserForDeletion(
	request: Request,
	env: Env,
) {
	return await readAuthenticatedAppUserInternal(request, env, true, false)
}
