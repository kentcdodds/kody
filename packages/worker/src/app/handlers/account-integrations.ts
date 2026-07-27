import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	loadAccountIntegrationByName,
	loadAccountIntegrationsData,
} from '#app/account-integrations-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createAccountIntegrationsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountIntegrations = await loadAccountIntegrationsData(env, user)
			return renderAppPage({
				request,
				env,
				title: 'Integrations',
				loaderData: { accountIntegrations },
			})
		},
	} satisfies Action<
		typeof routes.accountIntegrations | typeof routes.accountIntegrationDetail
	>
}

export function createAccountIntegrationsApiHandler(env: Env) {
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

			const name = new URL(request.url).searchParams.get('name')?.trim()
			if (name) {
				return jsonResponse({
					ok: true,
					integration: await loadAccountIntegrationByName(env, user, name),
				})
			}

			return jsonResponse(await loadAccountIntegrationsData(env, user))
		},
	} satisfies Action<typeof routes.accountIntegrationsApi>
}
