import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { redirectToLoginWhenUnauthenticated } from '#app/auth-redirect.ts'
import {
	type PermissionString,
	type RoleName,
	userHasPermission,
	userHasRole,
} from '#app/permissions.ts'
import { wantsJson } from '#worker/utils.ts'

export {
	assignUserRole,
	getUserRolesAndPermissions,
	removeAdminRolePreservingLastAdmin,
	removeUserRole,
} from '#app/permissions-db.ts'
export { userHasPermission, userHasRole } from '#app/permissions.ts'

function unauthorizedResponse(request: Request) {
	if (wantsJson(request)) {
		return new Response(JSON.stringify({ ok: false, error: 'Forbidden.' }), {
			status: 403,
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-store',
			},
		})
	}
	return new Response('Forbidden', { status: 403 })
}

async function unauthenticatedResponse(request: Request, env: Env) {
	if (wantsJson(request)) {
		return new Response(JSON.stringify({ ok: false, error: 'Unauthorized.' }), {
			status: 401,
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-store',
			},
		})
	}
	return redirectToLoginWhenUnauthenticated(request, env)
}

async function requireAuthorizedUser(
	request: Request,
	env: Env,
	check: (user: AuthenticatedAppUser) => boolean,
): Promise<AuthenticatedAppUser> {
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		throw await unauthenticatedResponse(request, env)
	}
	if (!check(user)) {
		throw unauthorizedResponse(request)
	}
	return user
}

export async function requireUserWithPermission(
	request: Request,
	env: Env,
	permission: PermissionString,
): Promise<AuthenticatedAppUser> {
	return requireAuthorizedUser(request, env, (user) =>
		userHasPermission(user, permission),
	)
}

export async function requireUserWithRole(
	request: Request,
	env: Env,
	role: RoleName,
): Promise<AuthenticatedAppUser> {
	return requireAuthorizedUser(request, env, (user) => userHasRole(user, role))
}
