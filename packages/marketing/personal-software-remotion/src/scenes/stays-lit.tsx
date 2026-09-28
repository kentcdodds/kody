import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { agentVisits, cues } from '../choreography.ts'
import { Headline, words } from '../components/headline.tsx'
import { MarkWell, type MarkId } from '../components/mark.tsx'
import { easeIn, mix, progress, settle } from '../motion.ts'
import { colors, fonts } from '../theme.ts'
import { framesPerBeat, scenes } from '../timing.ts'

const agents: ReadonlyArray<{ mark: MarkId; name: string }> = [
	{ mark: 'cursor', name: 'Cursor' },
	{ mark: 'claude', name: 'Claude' },
	{ mark: 'chatgpt', name: 'ChatGPT' },
]

const visits = agents.map((agent, index) => ({
	...agent,
	...agentVisits[index]!,
}))

const dock = { x: 1600, y: 120 }

function AgentChip({ frame }: { frame: number }) {
	return (
		<>
			{visits.map((visit) => {
				const arrive = settle(frame, visit.in, { damping: 16, stiffness: 150 })
				const leave = progress(frame, visit.out, visit.out + 8, easeIn)
				if (frame < visit.in - 1 || leave >= 1) return null
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
							padding: '10px 24px 10px 10px',
							borderRadius: 999,
							background: colors.surfaceRaised,
							border: `1.5px solid ${colors.border}`,
							boxShadow: '0 16px 40px oklch(0 0 0 / 0.45)',
							fontFamily: fonts.body,
							fontSize: 24,
							fontWeight: 700,
							whiteSpace: 'nowrap',
							color: colors.text,
							opacity: Math.min(1, arrive * 1.5) * (1 - leave),
							transform: `translate(-50%, -50%) translateY(${mix(-30, 0, arrive) + leave * 30}px)`,
						}}
					>
						<MarkWell id={visit.mark} size={50} radius={25} />
						{visit.name}
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
							at: cues.staysLitCopy + index * 3,
						})),
						...words('stays lit.', colors.lanternCore).map((word, index) => ({
							...word,
							at: cues.staysLitCopy + framesPerBeat + index * 4,
						})),
					],
				]}
				enterAt={cues.agentsCopy + 6}
				exitAt={scenes.staysLit.until - 36}
				fontSize={68}
				style={{ left: 120, top: 56 }}
			/>
		</AbsoluteFill>
	)
}
