import { type Action } from 'remix/router'
import { loadAccountSecretsData } from '#app/account-secrets-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

export function createConnectSecretSetHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			// Load secrets metadata without the setup query. Prefill params like
			// name + allowedHosts must not be parsed as a host-approval request.
			const secretsRequest = new Request(
				new URL('/account/secrets.json', request.url),
				{ headers: request.headers },
			)
			const accountSecrets = await loadAccountSecretsData({
				request: secretsRequest,
				env,
				user,
			})
			return renderAppPage({
				request,
				env,
				title: 'Set secret',
				loaderData: { accountSecrets },
			})
		},
	} satisfies Action<typeof routes.connectSecretSet>
}
