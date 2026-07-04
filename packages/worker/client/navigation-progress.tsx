import { addEventListeners, type Handle, css } from 'remix/ui'
import { routerEvents } from './client-router.tsx'
import { colors } from './styles/tokens.ts'

const showDelayMs = 150
const trickleIntervalMs = 200
const trickleIncrement = 4
const maxTrickleProgress = 90
const fadeDurationMs = 200

export function NavigationProgress(handle: Handle) {
	let visible = false
	let progress = 0
	let opacity = 0
	// Boolean, not a counter: navigations are latest-wins and a superseded
	// (aborted) navigation never dispatches its own `navigationend`, so the
	// winning navigation's end event must clear the pending state outright.
	let navigationPending = false
	let showTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null
	let trickleIntervalId: ReturnType<typeof globalThis.setInterval> | null = null
	let fadeTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null
	let resetTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null

	function clearShowTimeout() {
		if (showTimeoutId === null) return
		globalThis.clearTimeout(showTimeoutId)
		showTimeoutId = null
	}

	function clearTrickleInterval() {
		if (trickleIntervalId === null) return
		globalThis.clearInterval(trickleIntervalId)
		trickleIntervalId = null
	}

	function clearFadeTimers() {
		if (fadeTimeoutId !== null) {
			globalThis.clearTimeout(fadeTimeoutId)
			fadeTimeoutId = null
		}
		if (resetTimeoutId !== null) {
			globalThis.clearTimeout(resetTimeoutId)
			resetTimeoutId = null
		}
	}

	function startTrickle() {
		clearTrickleInterval()
		trickleIntervalId = globalThis.setInterval(() => {
			if (progress >= maxTrickleProgress) return
			progress = Math.min(maxTrickleProgress, progress + trickleIncrement)
			handle.update()
		}, trickleIntervalMs)
	}

	function scheduleShow() {
		clearShowTimeout()
		showTimeoutId = globalThis.setTimeout(() => {
			showTimeoutId = null
			if (!navigationPending) return
			visible = true
			opacity = 1
			if (progress === 0) progress = 8
			startTrickle()
			handle.update()
		}, showDelayMs)
	}

	function onNavigationStart() {
		navigationPending = true
		clearFadeTimers()
		if (!visible) {
			scheduleShow()
			return
		}
		opacity = 1
		if (progress >= 100) progress = 8
		startTrickle()
		handle.update()
	}

	function onNavigationEnd() {
		if (!navigationPending) return
		navigationPending = false

		clearShowTimeout()
		clearTrickleInterval()

		// Fast navigations that finished before the show delay stay invisible;
		// completing the bar for them would cause the flash the delay avoids.
		if (!visible) {
			progress = 0
			return
		}

		progress = 100
		opacity = 1
		handle.update()

		fadeTimeoutId = globalThis.setTimeout(() => {
			fadeTimeoutId = null
			opacity = 0
			handle.update()
			resetTimeoutId = globalThis.setTimeout(() => {
				resetTimeoutId = null
				visible = false
				progress = 0
				handle.update()
			}, fadeDurationMs)
		}, 80)
	}

	if (typeof document !== 'undefined') {
		addEventListeners(routerEvents, handle.signal, {
			navigationstart: onNavigationStart,
			navigationend: onNavigationEnd,
		})
	}

	return () => {
		if (typeof document === 'undefined' || !visible) return null

		return (
			<div
				aria-hidden="true"
				mix={css({
					position: 'fixed',
					top: 0,
					left: 0,
					width: '100%',
					height: '3px',
					zIndex: 9999,
					pointerEvents: 'none',
					backgroundColor: 'transparent',
				})}
			>
				<div
					mix={css({
						height: '100%',
						width: `${progress}%`,
						backgroundColor: colors.primary,
						opacity,
						transition: `width 200ms ease-out, opacity ${fadeDurationMs}ms ease-out`,
					})}
				/>
			</div>
		)
	}
}
