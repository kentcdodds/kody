import { type Handle } from 'remix/ui'
import {
	codeRunsWindowRefreshRetryMs,
	fetchCodeRunsPayload,
} from '#client/routes/code-runs-payload.ts'
import {
	codeRunsCatchUpDelayMs,
	codeRunsCatchUpSnapAfterMs,
	formatCodeRunsCount,
	interpolateCodeRunsCount,
	msUntilCodeRunsWindowRefresh,
	msUntilNextCodeRunsCount,
	nextDisplayedCodeRunsCount,
	publicCodeRunsWindowsEqual,
	type PublicCodeRunsWindow,
} from '#universal/code-runs.ts'

/**
 * 24-hour delayed fleet execute count. SSR paints the interpolated value;
 * the client advances one integer at a time, scheduled to the next hashed
 * fire so leftover ticks still wobble. A 3-second honesty slot is the
 * longest the official integer may sit when budget allows; thinner windows
 * wait for the next real +1 instead of inventing ticks. A frozen tab (rAF
 * gap, hidden, or a late timeout) snaps to the official count instead of
 * rolling through every missed integer. When no next integer can paint, the
 * ticker waits until `updateAt` then refetches `/code-runs.json`. Mono
 * digits plus a reserved width from `end` keep the label from shifting
 * as digits change.
 */
export function CodeRunsTicker(
	handle: Handle<{ window: PublicCodeRunsWindow }>,
) {
	let activeWindow = handle.props.window
	let displayed = interpolateCodeRunsCount(activeWindow, Date.now())
	let lastDisplayAt = Date.now()
	const prefersReducedMotion =
		typeof matchMedia === 'function' &&
		matchMedia('(prefers-reduced-motion: reduce)').matches

	if (typeof document !== 'undefined' && !prefersReducedMotion) {
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		let rafId: number | undefined
		let lastFrameAt = performance.now()

		function officialAt(now: number) {
			return interpolateCodeRunsCount(activeWindow, now)
		}

		async function refreshStuckWindow() {
			const payload = await fetchCodeRunsPayload(handle.signal, {
				cache: 'no-store',
			})
			if (handle.signal.aborted) return
			const next = payload?.window
			if (!next || publicCodeRunsWindowsEqual(next, activeWindow)) return
			activeWindow = next
		}

		function clearTimer() {
			if (timeoutId === undefined) return
			clearTimeout(timeoutId)
			timeoutId = undefined
		}

		function show(count: number, now: number) {
			if (count === displayed) return
			lastDisplayAt = now
			displayed = count
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
			const nowAfter = Date.now()
			show(officialAt(nowAfter), nowAfter)
			const delay = msUntilNextCodeRunsCount(activeWindow, nowAfter)
			if (delay === null) {
				const refreshIn = msUntilCodeRunsWindowRefresh(activeWindow, nowAfter)
				timeoutId = setTimeout(
					() => {
						void refreshStuckWindow().finally(() => {
							if (handle.signal.aborted) return
							scheduleNext()
						})
					},
					refreshIn > 0 ? refreshIn : codeRunsWindowRefreshRetryMs,
				)
				return
			}
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
		handle.queueTask(() => {
			scheduleNext()
			rafId = requestAnimationFrame(onFrame)
		})
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
		const reserved = formatCodeRunsCount(activeWindow.end)
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
				<span class="landing-hero-runs-caption">Sandboxed executes</span>
			</p>
		)
	}
}
