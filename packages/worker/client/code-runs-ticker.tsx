import { type Handle } from 'remix/ui'
import {
	codeRunsCatchUpDelayMs,
	codeRunsCatchUpSnapAfterMs,
	formatCodeRunsCount,
	interpolateCodeRunsCount,
	msUntilNextCodeRunsCount,
	nextDisplayedCodeRunsCount,
	type PublicCodeRunsWindow,
} from '#universal/code-runs.ts'

/**
 * 24-hour delayed fleet execute count. SSR paints the interpolated value;
 * the client advances one integer at a time, scheduled to the next hashed
 * fire so the cadence wobbles. A frozen tab (rAF gap, hidden, or a late
 * timeout) snaps to the official count instead of rolling through every
 * missed integer. Live leftover ticks in a busy second still step +1.
 * Mono digits plus a reserved width from `current` keep the label from
 * shifting as digits change. The line is sized larger than the hero subtitle.
 */
export function CodeRunsTicker(
	handle: Handle<{ window: PublicCodeRunsWindow }>,
) {
	let displayed = interpolateCodeRunsCount(handle.props.window, Date.now())
	let lastDisplayAt = Date.now()
	const prefersReducedMotion =
		typeof matchMedia === 'function' &&
		matchMedia('(prefers-reduced-motion: reduce)').matches

	if (typeof document !== 'undefined' && !prefersReducedMotion) {
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		let rafId: number | undefined
		let lastFrameAt = performance.now()

		function officialAt(now: number) {
			return interpolateCodeRunsCount(handle.props.window, now)
		}

		function clearTimer() {
			if (timeoutId === undefined) return
			clearTimeout(timeoutId)
			timeoutId = undefined
		}

		function show(count: number, now: number) {
			if (count === displayed) return
			displayed = count
			lastDisplayAt = now
			handle.update()
		}

		function snapToOfficial(now = Date.now()) {
			show(officialAt(now), now)
		}

		function scheduleNext() {
			if (handle.signal.aborted) return
			clearTimer()
			if (document.visibilityState === 'hidden') return
			const now = Date.now()
			const official = officialAt(now)
			if (displayed < official) {
				const behind = official - displayed
				const next = nextDisplayedCodeRunsCount({
					displayed,
					official,
					elapsedMsSinceDisplay: now - lastDisplayAt,
				})
				show(next, now)
				if (next < official) {
					timeoutId = setTimeout(() => {
						scheduleNext()
					}, codeRunsCatchUpDelayMs(behind))
					return
				}
			}
			const delay = msUntilNextCodeRunsCount(handle.props.window, Date.now())
			if (delay === null) return
			timeoutId = setTimeout(
				() => {
					scheduleNext()
				},
				Math.max(16, delay),
			)
		}

		function onFrame(timestamp: number) {
			if (handle.signal.aborted) return
			const gap = timestamp - lastFrameAt
			lastFrameAt = timestamp
			if (gap > codeRunsCatchUpSnapAfterMs) {
				snapToOfficial()
				scheduleNext()
			}
			rafId = requestAnimationFrame(onFrame)
		}

		document.addEventListener(
			'visibilitychange',
			() => {
				if (document.visibilityState === 'hidden') {
					clearTimer()
					snapToOfficial()
					return
				}
				lastFrameAt = performance.now()
				snapToOfficial()
				scheduleNext()
			},
			{ signal: handle.signal },
		)
		window.addEventListener(
			'pageshow',
			(event) => {
				if (!event.persisted) return
				lastFrameAt = performance.now()
				snapToOfficial()
				scheduleNext()
			},
			{ signal: handle.signal },
		)
		scheduleNext()
		rafId = requestAnimationFrame(onFrame)
		handle.signal.addEventListener(
			'abort',
			() => {
				clearTimer()
				if (rafId !== undefined) cancelAnimationFrame(rafId)
			},
			{ once: true },
		)
	}

	return () => {
		const reserved = formatCodeRunsCount(handle.props.window.current)
		return (
			<p data-rise style={{ '--rise': '1.5' }} class="landing-hero-runs">
				<span class="landing-hero-runs-line">
					<span
						class="landing-hero-runs-count"
						style={{ '--runs-ch': `${reserved.length}ch` }}
					>
						{formatCodeRunsCount(displayed)}
					</span>
					<span class="landing-hero-runs-label">code runs</span>
				</span>
				<span class="landing-hero-runs-caption">
					Sandboxed executes across Kody accounts
				</span>
			</p>
		)
	}
}
