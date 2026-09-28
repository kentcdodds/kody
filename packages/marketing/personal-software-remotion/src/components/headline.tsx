import { type CSSProperties } from 'react'
import { easeIn, mix, progress, settle } from '../motion.ts'
import { colors, fonts } from '../theme.ts'

export type HeadlineWord = { text: string; color?: string; at?: number }

/**
 * Kinetic headline: words rise out of a soft blur on a short stagger, then
 * lift away together. `at` on a word overrides its entrance so a punchline
 * can land on the beat.
 */
export function Headline({
	frame,
	lines,
	enterAt,
	exitAt,
	fontSize,
	stagger = 3,
	align = 'left',
	style,
	kicker,
}: {
	frame: number
	lines: ReadonlyArray<ReadonlyArray<HeadlineWord>>
	enterAt: number
	exitAt?: number
	fontSize: number
	stagger?: number
	align?: 'left' | 'center'
	style?: CSSProperties
	kicker?: { text: string; color: string }
}) {
	const exit = exitAt == null ? 0 : progress(frame, exitAt, exitAt + 12, easeIn)
	let wordIndex = 0

	return (
		<div
			style={{
				position: 'absolute',
				textAlign: align,
				fontFamily: fonts.display,
				fontWeight: 700,
				fontSize,
				lineHeight: 1.04,
				letterSpacing: '-0.025em',
				color: colors.text,
				opacity: 1 - exit,
				transform: `translateY(${exit * -24}px)`,
				filter: exit > 0 ? `blur(${exit * 10}px)` : undefined,
				...style,
			}}
		>
			{kicker ? (
				<div
					style={{
						fontFamily: fonts.body,
						fontWeight: 700,
						fontSize: fontSize * 0.24,
						letterSpacing: '0.16em',
						textTransform: 'uppercase',
						color: kicker.color,
						marginBottom: fontSize * 0.28,
						opacity: progress(frame, enterAt - 6, enterAt + 8),
					}}
				>
					{kicker.text}
				</div>
			) : null}
			{lines.map((line, lineIndex) => (
				<div key={lineIndex} style={{ whiteSpace: 'nowrap' }}>
					{line.map((word, index) => {
						const start = word.at ?? enterAt + wordIndex * stagger
						wordIndex++
						const rise = settle(frame, start, { damping: 17, stiffness: 140 })
						const visible = progress(frame, start, start + 9)
						return (
							<span
								key={index}
								style={{
									display: 'inline-block',
									marginRight: '0.24em',
									color: word.color ?? colors.text,
									opacity: visible,
									transform: `translateY(${mix(0.5, 0, rise) * fontSize}px)`,
									filter:
										visible < 1 ? `blur(${(1 - visible) * 12}px)` : undefined,
								}}
							>
								{word.text}
							</span>
						)
					})}
				</div>
			))}
		</div>
	)
}

/** Split a phrase into headline words that share one color. */
export function words(phrase: string, color?: string): Array<HeadlineWord> {
	return phrase.split(' ').map((text) => ({ text, color }))
}
