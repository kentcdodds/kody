import { type Action } from 'remix/router'
import { type routes } from '#universal/routes.ts'
import { handleWebhookIngressRequest } from '#worker/webhooks/http.ts'

/**
 * App-router registration for inbound webhook ingress. The Worker fetch
 * handler also intercepts this path early for subscription challenges and
 * ack-mode enqueue (before Remix routing). Ack work itself is durable via
 * `kody-webhook-dispatch` — not `ctx.waitUntil`.
 */
export function createWebhookIngressHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return handleWebhookIngressRequest(request, env)
		},
	} satisfies Action<typeof routes.webhookIngress>
}
