import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { Headline, words } from '../components/headline.tsx'
import { MarkWell, type MarkId } from '../components/mark.tsx'
import { easeIn, mix, progress, settle } from '../motion.ts'
import { colors, fonts } from '../theme.ts'
import { bar, scenes } from '../timing.ts'

type AgentVisit = { mark: MarkId | null; name: string; in: number; out: number }

const visits: ReadonlyArray<AgentVisit> = [
	{ mark: 'cursor', name: 'Cursor', in: bar(12, 2) + 4, out: bar(12, 3) + 12 },
	{ mark: 'claude', name: 'Claude', in: bar(12, 3) + 14, out: bar(13, 1) },
	{ mark: 'chatgpt', name: 'ChatGPT', in: bar(13, 1) + 2, out: bar(13, 2) - 2 },
	{
		mark: null,
		name: 'No agent connected',
		in: bar(13, 2),
		out: scenes.staysLit.until - 36,
	},
]

const dock = { x: 1600, y: 120 }

/** One agent at a time, then none. The grid keeps working either way. */
function AgentChip({ frame }: { frame: number }) {
	return (
		<>
			{visits.map((visit) => {
				const arrive = settle(frame, visit.in, { damping: 16, stiffness: 150 })
				const leave = progress(frame, visit.out, visit.out + 8, easeIn)
				if (frame < visit.in - 1 || leave >= 1) return null
				const empty = visit.mark == null
				return (
					<div
						key={visit.name}
						style={{
							position: 'absolute',
							left: dock.x,
							top: dock.y,
							display: 'flex',
							alignItems: 'center',
							gap: 14,
							padding: empty ? '14px 24px' : '10px 24px 10px 10px',
							borderRadius: 999,
							background: empty ? colors.canvas : colors.surfaceRaised,
							border: `1.5px ${empty ? 'dashed' : 'solid'} ${empty ? colors.fieldBorder : colors.border}`,
							boxShadow: '0 16px 40px oklch(0 0 0 / 0.45)',
							fontFamily: fonts.body,
							fontSize: 24,
							fontWeight: 700,
							whiteSpace: 'nowrap',
							color: empty ? colors.textMuted : colors.text,
							opacity: Math.min(1, arrive * 1.5) * (1 - leave),
							transform: `translate(-50%, -50%) translateY(${mix(-30, 0, arrive) + leave * 30}px)`,
						}}
					>
						{visit.mark ? (
							<MarkWell id={visit.mark} size={50} radius={25} />
						) : null}
						{visit.name}
						{empty ? null : (
							<span
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 8,
									fontSize: 18,
									color: colors.primaryText,
								}}
							>
								<span
									style={{
										width: 10,
										height: 10,
										borderRadius: '50%',
										background: colors.primary,
									}}
								/>
								connected
							</span>
						)}
					</div>
				)
			})}
		</>
	)
}

export function StaysLit() {
	const frame = useCurrentFrame() + scenes.staysLit.from
	return (
		<AbsoluteFill>
			<AgentChip frame={frame} />
			<Headline
				frame={frame}
				lines={[
					words('Agents come and go.'),
					[
						...words('Your software').map((word, index) => ({
							...word,
							at: bar(12, 3) + index * 3,
						})),
						...words('stays lit.', colors.lanternCore).map((word, index) => ({
							...word,
							at: bar(13) + index * 4,
						})),
					],
				]}
				enterAt={bar(12, 2) + 2}
				exitAt={scenes.staysLit.until - 36}
				fontSize={68}
				style={{ left: 120, top: 56 }}
			/>
		</AbsoluteFill>
	)
}
