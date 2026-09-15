import { requestHasSessionCookie } from '#app/anonymous-html-cache.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { userHasRole } from '#universal/permissions.ts'

/**
 * Whether this request belongs to a signed-in admin. Anonymous and
 * non-admin sessions are both false. Missing session cookie skips the
 * user lookup so public docs tests and caches stay cheap.
 */
export async function requestIsDocsAdmin(
	request: Request,
	env: Env,
): Promise<boolean> {
	if (!requestHasSessionCookie(request)) return false
	const user = await readAuthenticatedAppUser(request, env)
	return Boolean(user && userHasRole(user, 'admin'))
}

export function viewerCanAccessGuide(
	guide: { adminOnly: boolean },
	isAdmin: boolean,
): boolean {
	return !guide.adminOnly || isAdmin
}
