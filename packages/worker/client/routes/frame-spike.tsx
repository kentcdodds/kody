import { Frame, type Handle, on } from 'remix/ui'
import {
	FRAME_SPIKE_INCREMENT_PATH,
	FRAME_SPIKE_PATH,
	FRAME_SPIKE_TARGET,
} from '#client/frame-spike-constants.ts'

export function FrameSpikeRoute(handle: Handle) {
	if (typeof window !== 'undefined') {
		handle.queueTask(() => {
			;(
				window as Window & { __frameSpikeMarker?: boolean }
			).__frameSpikeMarker = true
		})
	}

	return () => (
		<section>
			<h1>Frame spike</h1>
			<p>
				POST increments a module counter, then reloads the named frame without
				full navigation.
			</p>
			<Frame name={FRAME_SPIKE_TARGET} src={FRAME_SPIKE_PATH} />
			<button
				type="button"
				data-testid="frame-spike-increment"
				mix={on('click', async (_event, signal) => {
					const response = await fetch(FRAME_SPIKE_INCREMENT_PATH, {
						method: 'POST',
						signal,
					})
					if (!response.ok) {
						throw new Error('Increment failed')
					}
					if (signal.aborted) return
					await handle.frames.get(FRAME_SPIKE_TARGET)?.reload()
				})}
			>
				Increment &amp; reload frame
			</button>
		</section>
	)
}
