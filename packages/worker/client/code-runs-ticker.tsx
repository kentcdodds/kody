import { type Handle } from 'remix/ui'
import {
	formatCodeRunsCount,
	interpolateCodeRunsCount,
	type PublicCodeRunsWindow,
} from '#universal/code-runs.ts'

/**
 * 24-hour delayed fleet execute count. SSR paints the bursty interpolated
 * value; the client advances it only when the displayed integer changes.
 * Mono digits plus a reserved width from `current` keep the label from
 * shifting as digits change. The line is sized larger than the hero subtitle.
 */
export function CodeRunsTicker(
	handle: Handle<{ window: PublicCodeRunsWindow }>,
) {
	let nowMs = Date.now()
	const prefersReducedMotion =
		typeof matchMedia === 'function' &&
		matchMedia('(prefers-reduced-motion: reduce)').matches

	if (typeof document !== 'undefined' && !prefersReducedMotion) {
		const interval = setInterval(() => {
			const nextMs = Date.now()
			const previousCount = interpolateCodeRunsCount(handle.props.window, nowMs)
			const nextCount = interpolateCodeRunsCount(handle.props.window, nextMs)
			nowMs = nextMs
			if (nextCount === previousCount) return
			handle.update()
		}, 1000)
		handle.signal.addEventListener(
			'abort',
			() => {
				clearInterval(interval)
			},
			{ once: true },
		)
	}

	return () => {
		const count = interpolateCodeRunsCount(handle.props.window, nowMs)
		const reserved = formatCodeRunsCount(handle.props.window.current)
		return (
			<p data-rise style={{ '--rise': '1.5' }} class="landing-hero-runs">
				<span
					class="landing-hero-runs-count"
					style={{ '--runs-ch': `${reserved.length}ch` }}
				>
					{formatCodeRunsCount(count)}
				</span>
				<span class="landing-hero-runs-label">code runs</span>
			</p>
		)
	}
}
