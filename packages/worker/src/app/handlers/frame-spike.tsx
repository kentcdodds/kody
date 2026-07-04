import { type Action } from 'remix/router'
import { handleFrameRequest } from '#app/frame-registry.ts'
import '#app/frame-registrations.ts'
import { incrementFrameSpikeCounter } from '#app/frame-spike-state.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createFrameSpikeHandler(env: Env) {
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
				title: 'Frame spike',
			})
		},
	} satisfies Action<typeof routes.frameSpike>
}

export function createFrameSpikeIncrementHandler(_env: Env) {
	return {
		middleware: [],
		async handler() {
			incrementFrameSpikeCounter()
			return new Response(null, { status: 204 })
		},
	} satisfies Action<typeof routes.frameSpikeIncrement>
}
