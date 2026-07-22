import { type Action } from 'remix/router'
import { requirePageSession } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createConnectOauthHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const sessionRedirect = await requirePageSession(request)
			if (sessionRedirect) {
				return sessionRedirect
			}
			return renderAppPage({
				request,
				env,
				title: 'Connect OAuth',
			})
		},
	} satisfies Action<typeof routes.connectOauth>
}
