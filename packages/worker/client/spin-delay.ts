import { type Handle } from 'remix/ui'

type SpinDelayState = 'IDLE' | 'DELAY' | 'DISPLAY' | 'EXPIRE'

type SpinDelayOptions = {
	delay?: number
	minDuration?: number
	ssr?: boolean
}

const defaultOptions = {
	delay: 500,
	minDuration: 200,
	ssr: true,
} as const satisfies Required<SpinDelayOptions>

export function createSpinDelay(handle: Handle, options?: SpinDelayOptions) {
	const resolvedOptions = {
		...defaultOptions,
		...options,
	}
	let loading = false
	let state: SpinDelayState = 'IDLE'
	const isSSR = typeof window === 'undefined' && resolvedOptions.ssr
	let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null

	function clearTimer() {
		if (timeoutId === null) return
		globalThis.clearTimeout(timeoutId)
		timeoutId = null
	}

	function setState(nextState: SpinDelayState, shouldEvaluate = true) {
		if (state === nextState) return
		state = nextState
		handle.update()
		if (shouldEvaluate) evaluate()
	}

	function evaluate() {
		if (loading && (state === 'IDLE' || isSSR)) {
			clearTimer()
			const delay = isSSR ? 0 : resolvedOptions.delay
			timeoutId = globalThis.setTimeout(() => {
				if (!loading) {
					setState('IDLE', false)
					return
				}

				timeoutId = globalThis.setTimeout(() => {
					setState('EXPIRE')
				}, resolvedOptions.minDuration)
				setState('DISPLAY')
			}, delay)

			if (!isSSR) {
				setState('DELAY', false)
			}
			return
		}

		if (!loading && state !== 'DISPLAY') {
			clearTimer()
			setState('IDLE', false)
		}
	}

	return {
		get state() {
			return state
		},
		get isShowing() {
			return state === 'DISPLAY' || state === 'EXPIRE'
		},
		setLoading(nextLoading: boolean) {
			if (loading === nextLoading) return
			loading = nextLoading
			evaluate()
		},
		reset() {
			clearTimer()
			loading = false
			setState('IDLE', false)
		},
	}
}
