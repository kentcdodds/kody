/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type RemixNode } from 'remix/ui'
import { type Action } from 'remix/router'
import { CommunityIndexOgHead } from '#app/ssr-document.tsx'
import { handleFrameRequest } from '#app/frame-registry.ts'
import '#app/frame-registrations.ts'
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

			return renderAppPage({
				request,
				env,
				title: 'Community packages',
				extraHead: (<CommunityIndexOgHead />) as RemixNode,
			})
		},
	} satisfies Action<typeof routes.community>
}

export { createCommunityApiHandler } from '#app/community-api.ts'
