/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { getFrameSpikeCounter } from '#app/frame-spike-state.ts'

export type FrameSpikeDataProps = {
	counter: number
	timestamp: string
}

export function FrameSpikeData(handle: Handle<FrameSpikeDataProps>) {
	return () => (
		<div id="frame-spike-data" data-testid="frame-spike-data">
			<p data-testid="frame-spike-counter">Counter: {handle.props.counter}</p>
			<p data-testid="frame-spike-timestamp">
				Timestamp: {handle.props.timestamp}
			</p>
		</div>
	)
}

export async function renderFrameSpikeDataHtml(
	timestamp = new Date().toISOString(),
) {
	return renderToString(
		<FrameSpikeData counter={getFrameSpikeCounter()} timestamp={timestamp} />,
	)
}
