import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { createPageOgHeadNode } from '#app/ssr-document.tsx'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createPrivacyHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const origin = getAppBaseUrl({ env, requestUrl: request.url })
			return renderAppPage({
				request,
				env,
				title: 'Privacy',
				extraHead: createPageOgHeadNode({ origin, pageId: 'privacy' }),
			})
		},
	} satisfies Action<typeof routes.privacy>
}
