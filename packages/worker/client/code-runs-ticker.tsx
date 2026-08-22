import { type Handle } from 'remix/ui'
import {
	formatCodeRunsCount,
	interpolateCodeRunsCount,
	msUntilNextCodeRunsCount,
	type PublicCodeRunsWindow,
} from '#universal/code-runs.ts'

/**
 * 24-hour delayed fleet execute count. SSR paints the interpolated value;
 * the client advances one integer at a time, scheduled to the next hashed
 * fire so the cadence wobbles. If the tab sleeps and the official count
 * jumps, leftover integers roll through one second unless more than
 * sixty are owed, in which case the display snaps. Mono digits plus a
 * reserved width from `current` keep the label from shifting as digits
 * change. The line is sized larger than the hero subtitle.
 */
export function CodeRunsTicker(
	handle: Handle<{ window: PublicCodeRunsWindow }>,
) {
	let displayed = interpolateCodeRunsCount(handle.props.window, Date.now())
	const prefersReducedMotion =
		typeof matchMedia === 'function' &&
		matchMedia('(prefers-reduced-motion: reduce)').matches

	if (typeof document !== 'undefined' && !prefersReducedMotion) {
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		function scheduleNext() {
			if (handle.signal.aborted) return
			const official = interpolateCodeRunsCount(handle.props.window, Date.now())
			if (displayed < official) {
				const behind = official - displayed
				if (behind > 60) {
					displayed = official
					handle.update()
					scheduleNext()
					return
				}
				displayed += 1
				handle.update()
				if (behind === 1) {
					scheduleNext()
					return
				}
				timeoutId = setTimeout(
					() => {
						scheduleNext()
					},
					Math.max(16, Math.floor(1000 / behind)),
				)
				return
			}
			const delay = msUntilNextCodeRunsCount(handle.props.window, Date.now())
			if (delay === null) return
			timeoutId = setTimeout(
				() => {
					const nextOfficial = interpolateCodeRunsCount(
						handle.props.window,
						Date.now(),
					)
					if (displayed < nextOfficial) displayed += 1
					handle.update()
					scheduleNext()
				},
				Math.max(16, delay),
			)
		}
		scheduleNext()
		handle.signal.addEventListener(
			'abort',
			() => {
				if (timeoutId !== undefined) clearTimeout(timeoutId)
			},
			{ once: true },
		)
	}

	return () => {
		const reserved = formatCodeRunsCount(handle.props.window.current)
		return (
			<p data-rise style={{ '--rise': '1.5' }} class="landing-hero-runs">
				<span
					class="landing-hero-runs-count"
					style={{ '--runs-ch': `${reserved.length}ch` }}
				>
					{formatCodeRunsCount(displayed)}
				</span>
				<span class="landing-hero-runs-label">code runs</span>
			</p>
		)
	}
}
