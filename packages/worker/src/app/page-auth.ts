import {
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import {
	destroyAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
} from '#app/auth-session.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import { loadRequestFeatureFlags } from '#app/request-feature-flags-cache.ts'
import { type RoleName } from '#universal/permissions.ts'

function prefetchHtmlFeatureFlags(
	request: Request,
	env: Env,
	user: AuthenticatedAppUser,
) {
	if (
		typeof env.APP_DB?.prepare !== 'function' ||
		typeof env.APP_DB.batch !== 'function'
	) {
		return
	}
	// Overlap flag evaluation with page-data loading. `loadSessionInfo`
	// awaits the same cached promise; the rejection handler is so a
	// prefetch that never reaches a render cannot become unhandled.
	void loadRequestFeatureFlags(request, env, {
		userId: user.userId,
		stableUserId: user.mcpUser.userId,
	}).then(undefined, () => {})
}

export async function requirePageSession(
	request: Request,
): Promise<Response | null> {
	const { session } = await readAuthSessionResult(request)
	if (!session) {
		return redirectToLogin(request)
	}

	return null
}

export async function requireAuthenticatedPageUser(
	request: Request,
	env: Env,
): Promise<AuthenticatedAppUser | Response> {
	const { session } = await readAuthSessionResult(request)
	if (!session) {
		return redirectToLogin(request)
	}

	const user = await readAuthenticatedAppUser(request, env)
	if (user) {
		prefetchHtmlFeatureFlags(request, env, user)
		return user
	}

	const resolved = await loadResolvedRequestAuth(request, env)
	if (resolved.user?.accountDeleting) {
		return redirectToLogin(request, {
			setCookie: await destroyAuthCookie(isSecureRequest(request)),
		})
	}

	return redirectToLoginWhenUnauthenticated(request, env)
}

export async function requirePageUserWithRole(
	request: Request,
	env: Env,
	role: RoleName,
): Promise<AuthenticatedAppUser | Response> {
	try {
		const user = await requireUserWithRole(request, env, role)
		prefetchHtmlFeatureFlags(request, env, user)
		return user
	} catch (error) {
		if (error instanceof Response) {
			return error
		}
		throw error
	}
}
