import { type Action } from 'remix/router'
import { loadCommunityIndexData } from '#app/community-data.ts'
import { handleFrameRequest } from '#app/frame-registry.ts'
import '#app/frame-registrations.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

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

			// Start listing load so the blocking Frame overlaps session/asset
			// work instead of waiting on D1 after streaming setup. resolveFrame
			// reuses this promise via the per-request memo.
			void loadCommunityIndexData(env, request)
			return renderAppPage({
				request,
				env,
			})
		},
	} satisfies Action<typeof routes.community>
}

export { createCommunityApiHandler } from '#app/community-api.ts'
