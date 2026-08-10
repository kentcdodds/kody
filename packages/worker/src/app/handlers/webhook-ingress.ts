import { type Action } from 'remix/router'
import { type routes } from '#universal/routes.ts'
import { handleWebhookIngressRequest } from '#worker/webhooks/http.ts'

/**
 * App-router registration for inbound webhook ingress. The Worker fetch
 * handler also intercepts this path early (so `ctx.waitUntil` is available for
 * ack-mode dispatch); this action keeps the route discoverable in the Remix
 * route map and covers any fall-through.
 */
export function createWebhookIngressHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return handleWebhookIngressRequest(request, env)
		},
	} satisfies Action<typeof routes.webhookIngress>
}
