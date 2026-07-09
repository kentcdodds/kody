/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { handleFrameRequest } from '#app/frame-registry.ts'
import '#app/frame-registrations.ts'
import { createPageOgHeadNode } from '#app/ssr-document.tsx'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createCommunityHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const frameResponse = await handleFrameRequest(
				request,
				env,
				new URL(request.url).pathname,
			)
			if (frameResponse) return frameResponse

			const origin = getAppBaseUrl({ env, requestUrl: request.url })

			return renderAppPage({
				request,
				env,
				title: 'Community packages',
				extraHead: createPageOgHeadNode({ origin, pageId: 'community' }),
			})
		},
	} satisfies Action<typeof routes.community>
}

export { createCommunityApiHandler } from '#app/community-api.ts'
