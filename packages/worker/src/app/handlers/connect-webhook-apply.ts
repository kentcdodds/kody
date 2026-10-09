import { type Action } from 'remix/router'
import { loadConnectWebhookApplyData } from '#app/connect-webhook-apply-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

export function createConnectWebhookApplyHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const connectWebhookApply = await loadConnectWebhookApplyData({
				env,
				user,
				requestUrl: request.url,
			})
			return renderAppPage({
				request,
				env,
				title: 'Approve webhook apply destination',
				loaderData: { connectWebhookApply },
			})
		},
	} satisfies Action<typeof routes.connectWebhookApply>
}
