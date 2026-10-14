import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type routes } from '#universal/routes.ts'

/**
 * Cookie-only commit after the client adopts an org-page prefetch that skipped
 * `Set-Cookie`. The org-binding guard resolves the Referer org and writes
 * `kody_last_org`; this handler only confirms the signed-in actor (#3517).
 */
export function createAccountLastUsedOrgApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}
			return jsonResponse({ ok: true })
		},
	} satisfies Action<typeof routes.accountLastUsedOrgApi>
}
