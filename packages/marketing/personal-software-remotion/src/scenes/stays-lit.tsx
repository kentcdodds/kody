import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { Beam } from '../components/beam.tsx'
import { Headline, words } from '../components/headline.tsx'
import { lanternPose, orbCenter } from '../components/lantern.tsx'
import { MarkWell, type MarkId } from '../components/mark.tsx'
import { triggerChipAnchor } from '../components/personal-app.tsx'
import { triggerTicks } from '../choreography.ts'
import { easeIn, mix, presence, progress, settle } from '../motion.ts'
import { colors, fonts, primitiveColors } from '../theme.ts'
import { bar, scenes } from '../timing.ts'

type AgentVisit = { mark: MarkId | null; name: string; in: number; out: number }

const visits: ReadonlyArray<AgentVisit> = [
	{ mark: 'cursor', name: 'Cursor', in: bar(11) - 2, out: bar(11, 2) - 2 },
	{ mark: 'claude', name: 'Claude', in: bar(11, 2), out: bar(11, 3) + 4 },
	{ mark: 'chatgpt', name: 'ChatGPT', in: bar(11, 3) + 6, out: bar(12) + 2 },
	{
		mark: null,
		name: 'No agent connected',
		in: bar(12) + 4,
		out: scenes.staysLit.until - 44,
	},
]

const dock = { x: 318, y: 952 }

function AgentDock({ frame }: { frame: number }) {
	const pose = lanternPose(frame)
	const lanternBase = { x: pose.x, y: pose.y + pose.height / 2 - 6 }
	return (
		<>
			<svg
				width={1920}
				height={1080}
				style={{ position: 'absolute', inset: 0 }}
			>
				{visits.map((visit) => {
					if (!visit.mark) return null
					const connected = presence(frame, {
						in: visit.in + 4,
						out: visit.out - 4,
						enter: 6,
						exit: 6,
					})
					return (
						<Beam
							key={visit.name}
							from={lanternBase}
							to={{ x: dock.x, y: dock.y - 40 }}
							bend={0}
							color={colors.text}
							draw={connected > 0 ? 1 : 0}
							flow={frame / 5}
							opacity={connected * 0.7}
							width={2}
						/>
					)
				})}
			</svg>
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
							padding: empty ? '14px 22px' : '10px 22px 10px 10px',
							borderRadius: 999,
							background: empty ? 'transparent' : colors.surfaceRaised,
							border: `1.5px ${empty ? 'dashed' : 'solid'} ${empty ? colors.fieldBorder : colors.border}`,
							fontFamily: fonts.body,
							fontSize: 22,
							fontWeight: 700,
							whiteSpace: 'nowrap',
							color: empty ? colors.textMuted : colors.text,
							opacity: Math.min(1, arrive * 1.5) * (1 - leave),
							transform: `translate(-50%, -50%) translateY(${mix(34, 0, arrive) + leave * 34}px)`,
						}}
					>
						{visit.mark ? (
							<MarkWell id={visit.mark} size={48} radius={24} />
						) : null}
						{visit.name}
						{empty ? null : (
							<span
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 8,
									fontSize: 17,
									color: colors.primaryText,
								}}
							>
								<span
									style={{
										width: 9,
										height: 9,
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

function TriggerBeams({ frame }: { frame: number }) {
	const pose = lanternPose(frame)
	return (
		<svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
			{triggerTicks.map((tick) => (
				<Beam
					key={tick}
					from={orbCenter(pose, 'triggers', frame)}
					to={triggerChipAnchor}
					bend={-0.2}
					color={primitiveColors.triggers}
					draw={progress(frame, tick - 6, tick + 2)}
					flow={frame / 4}
					opacity={1 - progress(frame, tick + 14, tick + 24)}
					width={3.5}
				/>
			))}
		</svg>
	)
}

export function StaysLit() {
	const frame = useCurrentFrame() + scenes.staysLit.from
	return (
		<AbsoluteFill>
			<TriggerBeams frame={frame} />
			<AgentDock frame={frame} />
			<Headline
				frame={frame}
				lines={[
					words('Agents come and go.'),
					[
						...words('Your software').map((word, index) => ({
							...word,
							at: bar(11, 2) + index * 3,
						})),
						...words('stays lit.', colors.lanternCore).map((word, index) => ({
							...word,
							at: bar(11, 3) + index * 4,
						})),
					],
				]}
				enterAt={bar(11) + 4}
				exitAt={scenes.staysLit.until - 44}
				fontSize={76}
				style={{ left: 120, top: 70 }}
			/>
		</AbsoluteFill>
	)
}
