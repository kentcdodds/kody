import { type Action } from 'remix/router'
import { loadAccountWebhooksData } from '#app/package-webhooks-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { jsonResponse } from '#worker/json-response.ts'
import { type routes } from '#universal/routes.ts'

/**
 * Page handler for `/account/webhooks`: the cross-package index. Each row
 * deep-links into the owning package's settings, where the URL actions live.
 */
export function createAccountWebhooksHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			const accountWebhooks = await loadAccountWebhooksData({
				env,
				requestUrl: request.url,
				user,
			})
			return renderAppPage({
				request,
				env,
				title: 'Webhooks',
				loaderData: { accountWebhooks },
			})
		},
	} satisfies Action<typeof routes.accountWebhooks>
}

/**
 * JSON API for `/account/webhooks.json`: GET lists every declared webhook
 * with minted state and never the URL. Mutations (mint, rotate, reveal,
 * enable, disable) live on the package-scoped
 * `/profiles/:username/packages/:kodyId/webhooks.json`.
 */
export function createAccountWebhooksApiHandler(env: Env) {
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
			return jsonResponse(
				await loadAccountWebhooksData({
					env,
					requestUrl: request.url,
					user,
				}),
			)
		},
	} satisfies Action<typeof routes.accountWebhooksApi>
}
