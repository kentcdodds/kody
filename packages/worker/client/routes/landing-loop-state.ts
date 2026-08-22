import {
	type TranscriptAct,
	type TranscriptLine,
} from './interactive-guide-transcript.ts'

export const landingLoopTeaser = {
	kicker: 'Example of a conversation you might have with your agent.',
	title: 'Ask once',
	user: 'What did my favorite bot ship recently on GitHub?',
} as const

/** Act header plus the first user turn — matches the SSR teaser. */
export const landingLoopTeaserBeatCount = 2

export type LandingLoopPauseReason =
	| 'hover'
	| 'focus'
	| 'explore'
	| 'offscreen'
	| 'manual'

export type LandingLoopBeat =
	| {
			kind: 'act'
			id: string
			kicker: string
			title: string
	  }
	| {
			kind: 'line'
			actId: string
			line: TranscriptLine
	  }

export type LandingLoopAdvance = {
	didAdvance: boolean
	looped: boolean
}

export function flattenTranscriptActs(
	acts: ReadonlyArray<TranscriptAct>,
): Array<LandingLoopBeat> {
	const beats: Array<LandingLoopBeat> = []
	for (const act of acts) {
		beats.push({
			kind: 'act',
			id: act.id,
			kicker: act.kicker,
			title: act.title,
		})
		for (const line of act.lines) {
			beats.push({ kind: 'line', actId: act.id, line })
		}
	}
	return beats
}

export function landingLoopHoldMs(beat: LandingLoopBeat | 'loop'): number {
	if (beat === 'loop') return 4000
	if (beat.kind === 'act') return 1100
	switch (beat.line.role) {
		case 'user':
		case 'agent':
			return Math.min(2200, 500 + beat.line.text.length * 4) + 700
		case 'tools':
		case 'files':
			return 1500
		default: {
			const exhaustive: never = beat.line
			return exhaustive
		}
	}
}

export function createLandingLoopPlayer(input: {
	beatCount: number
	reducedMotion: boolean
}) {
	const listeners = new Set<() => void>()
	const reasons = new Set<LandingLoopPauseReason>()
	let revealedCount = input.reducedMotion
		? input.beatCount
		: Math.min(landingLoopTeaserBeatCount, input.beatCount)
	let ignorePointerPause = false

	function emit() {
		for (const listener of Array.from(listeners)) listener()
	}

	function isPaused() {
		return input.reducedMotion || reasons.size > 0
	}

	function setReason(reason: LandingLoopPauseReason, on: boolean) {
		const had = reasons.has(reason)
		if (on) reasons.add(reason)
		else reasons.delete(reason)
		if (had === on) return
		emit()
	}

	return {
		get revealedCount() {
			return revealedCount
		},
		isPaused,
		pauseReasons(): Array<LandingLoopPauseReason> {
			return [...reasons]
		},
		subscribe(listener: () => void) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		setHover(on: boolean) {
			if (!on) {
				ignorePointerPause = false
				setReason('hover', false)
				return
			}
			if (ignorePointerPause) return
			setReason('hover', true)
		},
		setFocus(on: boolean) {
			if (!on) {
				ignorePointerPause = false
				setReason('focus', false)
				return
			}
			if (ignorePointerPause) return
			setReason('focus', true)
		},
		setExplore(on: boolean) {
			setReason('explore', on)
		},
		setOffscreen(on: boolean) {
			setReason('offscreen', on)
		},
		pause() {
			ignorePointerPause = false
			setReason('manual', true)
		},
		play() {
			const wasPointerPaused = reasons.has('hover') || reasons.has('focus')
			if (wasPointerPaused) ignorePointerPause = true
			reasons.delete('explore')
			reasons.delete('manual')
			reasons.delete('hover')
			reasons.delete('focus')
			emit()
		},
		advance(): LandingLoopAdvance {
			if (isPaused() || input.beatCount === 0) {
				return { didAdvance: false, looped: false }
			}
			if (revealedCount >= input.beatCount) {
				revealedCount = Math.min(landingLoopTeaserBeatCount, input.beatCount)
				emit()
				return { didAdvance: true, looped: true }
			}
			revealedCount += 1
			emit()
			return { didAdvance: true, looped: false }
		},
	}
}

export async function waitLandingLoopHold(input: {
	ms: number
	isPaused: () => boolean
	subscribe: (listener: () => void) => () => void
	signal: AbortSignal
}): Promise<boolean> {
	let remaining = input.ms

	function waitFor(kind: 'slice' | 'resume', ms?: number) {
		return new Promise<'sleep' | 'abort' | 'change'>((resolve) => {
			const timer =
				kind === 'slice' && ms != null
					? setTimeout(() => finish('sleep'), ms)
					: null
			function finish(event: 'sleep' | 'abort' | 'change') {
				if (timer != null) clearTimeout(timer)
				input.signal.removeEventListener('abort', onAbort)
				unsubscribe()
				resolve(event)
			}
			function onAbort() {
				finish('abort')
			}
			const unsubscribe = input.subscribe(() => {
				finish('change')
			})
			input.signal.addEventListener('abort', onAbort, { once: true })
			if (input.signal.aborted) finish('abort')
		})
	}

	while (remaining > 0) {
		if (input.signal.aborted) return false
		if (input.isPaused()) {
			const event = await waitFor('resume')
			if (event === 'abort') return false
			continue
		}
		const slice = Math.min(remaining, 200)
		const started = Date.now()
		const event = await waitFor('slice', slice)
		if (event === 'abort') return false
		if (event === 'change') {
			remaining -= Date.now() - started
			continue
		}
		remaining -= slice
	}
	return !input.signal.aborted
}
