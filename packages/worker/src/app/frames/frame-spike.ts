import { renderFrameSpikeDataHtml } from '#app/frame-spike-content.tsx'
import { registerFrame } from '#app/frame-registry.ts'
import { FRAME_SPIKE_TARGET } from '#app/frame-spike-state.ts'
import { routes } from '#app/routes.ts'

registerFrame(FRAME_SPIKE_TARGET, {
	routePathname: routes.frameSpike.href(),
	render: () => renderFrameSpikeDataHtml(),
})
