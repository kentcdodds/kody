import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { Beam } from '../components/beam.tsx'
import { Headline, words } from '../components/headline.tsx'
import { lanternPose, orbCenter } from '../components/lantern.tsx'
import { MarkWell } from '../components/mark.tsx'
import { appFrame, cardPort } from '../components/personal-app.tsx'
import { cardFetches, cues } from '../choreography.ts'
import { easeIn, easeInOut, mix, progress, pulse, settle } from '../motion.ts'
import { colors, fonts, primitiveColors } from '../theme.ts'
import { bar, scenes } from '../timing.ts'

const prompt = 'Build me a morning dashboard: meetings, inbox, PRs, revenue.'
const promptIn = bar(8, 2)
const typeStart = promptIn + 6
const typeEnd = cues.appBuild - 12
const sendAt = typeEnd + 2
const promptWidth = 1010

export function GenerateApp() {
	const frame = useCurrentFrame() + scenes.generateApp.from
	return (
		<AbsoluteFill>
			<Headline
				frame={frame}
				lines={[
					words('Generate software'),
					[
						...words('that already has the'),
						{ text: 'connections.', color: primitiveColors.integrations },
					],
				]}
				enterAt={bar(8) + 12}
				exitAt={scenes.staysLit.from - 8}
				fontSize={76}
				stagger={3}
				style={{ left: 120, top: 70 }}
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

/** Lantern → app wiring. Stays up through beat 4 while agents change. */
export function AppBeams() {
	const frame = useCurrentFrame() + scenes.generateApp.from
	const pose = lanternPose(frame)
	const fade =
		1 -
		progress(
			frame,
			scenes.staysLit.until - 50,
			scenes.staysLit.until - 32,
			easeIn,
		)
	if (frame < cues.appBuild - 6) return null
	return (
		<svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
			<Beam
				from={orbCenter(pose, 'apps', frame)}
				to={{ x: appFrame.left, y: appFrame.top + 120 }}
				bend={-0.16}
				color={primitiveColors.apps}
				draw={progress(frame, cues.appBuild - 4, cues.appBuild + 10)}
				flow={frame / 7}
				opacity={fade}
			/>
			{cardFetches.map((at, index) => (
				<Beam
					key={at}
					from={orbCenter(pose, 'integrations', frame)}
					to={cardPort(index)}
					bend={0.06 + index * 0.02}
					color={primitiveColors.integrations}
					draw={progress(frame, at - 12, at)}
					flow={frame / 6 + index}
					opacity={fade * 0.9}
					width={2.5}
				/>
			))}
		</svg>
	)
}
