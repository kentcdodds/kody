import { type Action } from 'remix/router'
import { renderFrameSpikeDataHtml } from '#app/frame-spike-content.tsx'
import {
	FRAME_SPIKE_TARGET,
	incrementFrameSpikeCounter,
	REMIX_FRAME_TARGET_HEADER,
} from '#app/frame-spike-state.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

function isFrameSpikeDataRequest(request: Request) {
	return request.headers.get(REMIX_FRAME_TARGET_HEADER) === FRAME_SPIKE_TARGET
}

export function createFrameSpikeHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (isFrameSpikeDataRequest(request)) {
				const html = await renderFrameSpikeDataHtml()
				return new Response(html, {
					headers: {
						'Cache-Control': 'no-store',
						'Content-Type': 'text/html; charset=utf-8',
					},
				})
			}

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
