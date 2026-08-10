import { type Handle, css } from 'remix/ui'
import { radius } from '#universal/styles/tokens.ts'
import {
	getSwapLabelCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

/**
 * The stages a one-click community install actually walks through
 * (`installCommunityListing`): fork the snapshot into the viewer's account,
 * run the standard package checks over it, then refresh the saved-package
 * projection that wires up exports, jobs, and services.
 */
export const installProgressWords = [
	'Forking',
	'Copying',
	'Checking',
	'Bundling',
	'Publishing',
	'Wiring',
] as const

const defaultWordHoldMs = 2600

const dotColumns = 3
const dotRows = 3
const dotCount = dotColumns * dotRows
const dotIndexes = Array.from({ length: dotCount }, (_, index) => index)
const dotSize = '4px'
const dotGap = '2px'
// One diagonal of the matrix lights per step, so the wave reads as a sweep
// across the grid rather than nine dots blinking together.
const dotWaveStepMs = 110
const dotWaveDurationMs = 1200

function getDotWaveDelayCss() {
	const rules: Record<string, { animationDelay: string }> = {}
	for (const index of dotIndexes) {
		const diagonal = Math.floor(index / dotColumns) + (index % dotColumns)
		rules[`& > span:nth-child(${index + 1})`] = {
			animationDelay: `${diagonal * dotWaveStepMs}ms`,
		}
	}
	return rules
}

const loaderCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: '0.5rem',
}

/**
 * The dots inherit `currentColor`, so the matrix picks up whatever face the
 * button it sits in already wears (on-primary in a filled pill, body text in
 * a ghost). Under reduced motion the wave never starts and the evenly lit
 * grid below is the whole loader — calm, but still visibly not the idle
 * label.
 */
const dotMatrixCss = {
	display: 'grid',
	gridTemplateColumns: `repeat(${dotColumns}, ${dotSize})`,
	gridTemplateRows: `repeat(${dotRows}, ${dotSize})`,
	gap: dotGap,
	flex: 'none',
	'& > span': {
		borderRadius: radius.full,
		backgroundColor: 'currentColor',
		opacity: 0.45,
	},
	'@keyframes action-button-dot-wave': {
		'0%, 70%, 100%': { opacity: 0.2, scale: '0.7' },
		'25%': { opacity: 1, scale: '1' },
	},
	'@media (prefers-reduced-motion: no-preference)': {
		'& > span': {
			animation: `action-button-dot-wave ${dotWaveDurationMs}ms ease-in-out infinite`,
		},
		...getDotWaveDelayCss(),
	},
}

// Every word stays in the same grid cell so the button keeps one width for
// the whole wait; only the active one is painted.
const progressWordCss = getSwapLabelCss()

type ActionButtonLoaderProps = {
	/**
	 * Names the pending action for assistive technology ("Installing") for as
	 * long as the work runs. The rotating word is only ever a suffix on it,
	 * and it is the visible label when no words are given.
	 */
	label: string
	/**
	 * Rotating one-word stages. These are held on a timer, not driven by
	 * server progress — a one-click install is a single request with no
	 * progress stream — so they name what the operation does and stop on the
	 * last word instead of looping or implying a percentage.
	 */
	words?: ReadonlyArray<string>
	/** How long each word holds before the next one takes over. */
	wordHoldMs?: number
}

/**
 * The loading face of an action button: a dot-matrix wave plus an optional
 * rotation of one-word stages. Render it as the button's children while the
 * action is pending, and put `disabled` and `aria-busy` on the button itself.
 */
export function ActionButtonLoader(handle: Handle<ActionButtonLoaderProps>) {
	let wordIndex = 0
	let intervalId: ReturnType<typeof globalThis.setInterval> | null = null

	function stopRotation() {
		if (intervalId === null) return
		globalThis.clearInterval(intervalId)
		intervalId = null
	}

	// The rotation keeps running under reduced motion: swapping a word is a
	// content change, not movement, and it is the only progress feedback left
	// once the wave is off.
	if (
		typeof document !== 'undefined' &&
		(handle.props.words?.length ?? 0) > 1
	) {
		intervalId = globalThis.setInterval(() => {
			wordIndex += 1
			if (wordIndex >= (handle.props.words?.length ?? 0) - 1) stopRotation()
			handle.update()
		}, handle.props.wordHoldMs ?? defaultWordHoldMs)
		handle.signal.addEventListener('abort', stopRotation)
	}

	return () => {
		const words = handle.props.words ?? []
		const activeIndex = Math.min(wordIndex, words.length - 1)
		const activeWord = words[activeIndex] ?? null

		return (
			<span mix={css(loaderCss)}>
				<span aria-hidden="true" mix={css(dotMatrixCss)}>
					{dotIndexes.map((index) => (
						<span key={index} />
					))}
				</span>
				{activeWord === null ? (
					<span>{handle.props.label}</span>
				) : (
					<>
						<span aria-hidden="true" mix={css(progressWordCss)}>
							{words.map((word, index) => (
								<span
									key={index}
									data-swap-label
									data-active={index === activeIndex ? 'true' : undefined}
								>
									{word}
								</span>
							))}
						</span>
						<span mix={css(visuallyHiddenCss)}>{handle.props.label}</span>
						<span role="status" aria-live="polite" mix={css(visuallyHiddenCss)}>
							{activeWord}
						</span>
					</>
				)}
			</span>
		)
	}
}
