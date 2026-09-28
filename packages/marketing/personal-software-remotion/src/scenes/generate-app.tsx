import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { appTiles } from '../app-grid.ts'
import { Headline, words } from '../components/headline.tsx'
import { MarkWell } from '../components/mark.tsx'
import { appFrame } from '../components/personal-app.tsx'
import { cues } from '../choreography.ts'
import { easeIn, easeInOut, mix, progress, pulse, settle } from '../motion.ts'
import { colors, fonts, primitiveColors } from '../theme.ts'
import { bar, scenes } from '../timing.ts'

const prompt = 'Build me a morning dashboard: meetings, inbox, PRs, revenue.'
const promptIn = bar(9, 1)
const typeStart = promptIn + 6
const typeEnd = cues.appBuild - 12
const sendAt = typeEnd + 2
const promptWidth = 1010

const zeroTallies = [
	{ label: 'New sign-ins', count: 0 },
	{ label: 'API keys pasted', count: 0 },
]

/** The inverse of Beat 1: the app count climbs, the setup stays at zero. */
function Tallies({ frame }: { frame: number }) {
	const appear = cues.zoomOut.start + 8
	const leave = progress(
		frame,
		scenes.staysLit.from - 6,
		scenes.staysLit.from + 6,
		easeIn,
	)
	const apps = 1 + appTiles.filter((tile) => frame >= tile.spawnAt).length
	const chips = [{ label: 'Apps', count: apps, live: true }, ...zeroTallies]
	return (
		<div
			style={{
				position: 'absolute',
				left: 124,
				top: 214,
				display: 'flex',
				gap: 14,
				opacity: 1 - leave,
			}}
		>
			{chips.map((chip, index) => {
				const show = settle(frame, appear + index * 5)
				return (
					<div
						key={chip.label}
						style={{
							padding: '10px 20px',
							borderRadius: 14,
							background: colors.surface,
							border: `1px solid ${colors.border}`,
							fontFamily: fonts.body,
							fontSize: 22,
							color: colors.textMuted,
							whiteSpace: 'nowrap',
							opacity: show,
							transform: `translateY(${mix(16, 0, show)}px)`,
						}}
					>
						{chip.label}{' '}
						<span
							style={{
								fontFamily: fonts.display,
								fontWeight: 800,
								fontSize: 26,
								color: 'live' in chip ? primitiveColors.apps : colors.primary,
							}}
						>
							×{chip.count}
						</span>
					</div>
				)
			})}
		</div>
	)
}

export function GenerateApp() {
	const frame = useCurrentFrame() + scenes.generateApp.from
	return (
		<AbsoluteFill>
			<Tallies frame={frame} />
			<Headline
				frame={frame}
				lines={[
					words('Generate software'),
					[
						...words('that already has the'),
						{ text: 'connections.', color: primitiveColors.integrations },
					],
				]}
				enterAt={bar(9) + 12}
				exitAt={scenes.staysLit.from - 6}
				fontSize={68}
				stagger={3}
				style={{ left: 120, top: 56 }}
			/>
		</AbsoluteFill>
	)
}

/** The agent's request. It types, sends, then folds into the app's title bar. */
export function PromptBar() {
	const frame = useCurrentFrame() + scenes.generateApp.from
	if (frame < promptIn - 1 || frame > cues.appBuild + 16) return null
	const show = settle(frame, promptIn, { damping: 18, stiffness: 120 })
	const typed = Math.round(
		progress(frame, typeStart, typeEnd, (t) => t) * prompt.length,
	)
	const send = pulse(frame, sendAt, 12)
	const fold = progress(frame, cues.appBuild - 6, cues.appBuild + 12, easeInOut)
	const centerX = appFrame.left + appFrame.width / 2
	const y = mix(560, appFrame.top + 29, fold)
	const width = mix(promptWidth, appFrame.width, fold)
	return (
		<div
			style={{
				position: 'absolute',
				left: centerX - width / 2,
				top: y - 52,
				width,
				height: mix(104, 58, fold),
				display: 'flex',
				alignItems: 'center',
				gap: 20,
				padding: '0 22px',
				borderRadius: mix(28, 22, fold),
				background: colors.surfaceRaised,
				border: `2px solid ${send > 0.05 ? colors.primary : colors.fieldBorder}`,
				boxShadow: `0 30px 70px oklch(0 0 0 / 0.5), 0 0 ${send * 50}px ${colors.primary}`,
				opacity:
					Math.min(1, show * 1.4) *
					(1 - progress(frame, cues.appBuild + 4, cues.appBuild + 16, easeIn)),
				transform: `translateY(${mix(30, 0, show)}px)`,
				fontFamily: fonts.body,
			}}
		>
			<MarkWell id="cursor" size={56} radius={16} />
			<div
				style={{
					fontSize: 30,
					color: colors.text,
					whiteSpace: 'nowrap',
					overflow: 'hidden',
					flex: 1,
					opacity: 1 - fold,
				}}
			>
				{prompt.slice(0, typed)}
				<span
					style={{
						display: 'inline-block',
						width: 3,
						height: 32,
						marginLeft: 3,
						verticalAlign: 'middle',
						background: colors.primary,
						opacity:
							typed < prompt.length || Math.floor(frame / 8) % 2 === 0 ? 1 : 0,
					}}
				/>
			</div>
			<div
				style={{
					width: 56,
					height: 56,
					borderRadius: '50%',
					display: 'grid',
					placeItems: 'center',
					background: typed >= prompt.length ? colors.primary : colors.surface,
					color: colors.onPrimary,
					fontSize: 30,
					fontWeight: 800,
					transform: `scale(${1 + send * 0.18})`,
					opacity: 1 - fold,
				}}
			>
				↑
			</div>
		</div>
	)
}
