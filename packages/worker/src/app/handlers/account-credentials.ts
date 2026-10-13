import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	listCredentialsForViewer,
	readCredentialListFilters,
} from '#worker/credentials/credential-list.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { type routes } from '#universal/routes.ts'

/**
 * `GET /account/credentials.json`: the request org's credentials list as
 * `CredentialListItem`s. A fetch from an `/@slug/-/…` page binds that org.
 */
export function createAccountCredentialsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const credentials = await listCredentialsForViewer({
				env,
				request: user.request,
				filters: readCredentialListFilters(new URL(request.url).searchParams),
			})
			return jsonResponse({ ok: true, credentials })
		},
	} satisfies Action<typeof routes.accountCredentialsApi>
}
