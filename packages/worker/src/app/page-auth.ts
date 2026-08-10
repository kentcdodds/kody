import {
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { type RoleName } from '#universal/permissions.ts'

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
	if (!user) {
		return redirectToLoginWhenUnauthenticated(request, env)
	}

	return user
}

export async function requirePageUserWithRole(
	request: Request,
	env: Env,
	role: RoleName,
): Promise<AuthenticatedAppUser | Response> {
	try {
		return await requireUserWithRole(request, env, role)
	} catch (error) {
		if (error instanceof Response) {
			return error
		}
		throw error
	}
}
