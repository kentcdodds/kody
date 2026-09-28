import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { landingHomePrimitives } from '../../../../worker/universal/landing-home-copy.ts'
import { type LandingPrimitiveId } from '../../../../worker/universal/landing-lantern.ts'
import { Beam } from '../components/beam.tsx'
import { Headline, words } from '../components/headline.tsx'
import { lanternPose, orbCenter } from '../components/lantern.tsx'
import { MarkWell, type MarkId } from '../components/mark.tsx'
import { arrivals, cues } from '../choreography.ts'
import {
	easeIn,
	easeInOut,
	mix,
	presence,
	progress,
	quadraticPoint,
	settle,
} from '../motion.ts'
import { colors, fonts, primitiveColors } from '../theme.ts'
import { bar, scenes } from '../timing.ts'

const flightFrames = 40
const labelsOut = bar(7, 2) + 10
const panelsIn = bar(7, 3) + 4
const sceneOut = scenes.connectOnce.until - 22

const labelSides: Record<
	LandingPrimitiveId,
	{ side: 'left' | 'right'; y: number }
> = {
	memory: { side: 'left', y: 322 },
	secrets: { side: 'left', y: 452 },
	triggers: { side: 'left', y: 582 },
	packages: { side: 'right', y: 322 },
	integrations: { side: 'right', y: 452 },
	apps: { side: 'right', y: 582 },
}

const leftLabelEdge = 648
const rightLabelEdge = 1272

function PrimitiveLabels({ frame }: { frame: number }) {
	const pose = lanternPose(frame)
	return (
		<>
			<svg
				width={1920}
				height={1080}
				style={{ position: 'absolute', inset: 0 }}
			>
				{landingHomePrimitives.map((primitive) => {
					const layout = labelSides[primitive.id]
					const start = cues.orbLit[primitive.id]
					const draw = progress(frame, start, start + 14)
					const fade = 1 - progress(frame, labelsOut, labelsOut + 12, easeIn)
					const to = {
						x:
							layout.side === 'left' ? leftLabelEdge + 22 : rightLabelEdge - 22,
						y: layout.y,
					}
					return (
						<Beam
							key={primitive.id}
							from={orbCenter(pose, primitive.id, frame)}
							to={to}
							bend={layout.side === 'left' ? 0.08 : -0.08}
							color={primitiveColors[primitive.id]}
							draw={draw}
							flow={frame / 8}
							opacity={fade}
							width={2.5}
						/>
					)
				})}
			</svg>
			{landingHomePrimitives.map((primitive) => {
				const layout = labelSides[primitive.id]
				const start = cues.orbLit[primitive.id] + 6
				const show = settle(frame, start, { damping: 16, stiffness: 150 })
				const fade = 1 - progress(frame, labelsOut, labelsOut + 12, easeIn)
				const isLeft = layout.side === 'left'
				return (
					<div
						key={primitive.id}
						style={{
							position: 'absolute',
							top: layout.y - 30,
							...(isLeft
								? { right: 1920 - leftLabelEdge }
								: { left: rightLabelEdge }),
							display: 'flex',
							flexDirection: isLeft ? 'row-reverse' : 'row',
							alignItems: 'center',
							gap: 16,
							height: 60,
							opacity: Math.min(1, show * 1.4) * fade,
							transform: `translateX(${mix(isLeft ? 30 : -30, 0, show)}px)`,
						}}
					>
						<div
							style={{
								width: 16,
								height: 16,
								borderRadius: '50%',
								background: primitiveColors[primitive.id],
								boxShadow: `0 0 16px ${primitiveColors[primitive.id]}`,
							}}
						/>
						<div
							style={{
								fontFamily: fonts.display,
								fontWeight: 700,
								fontSize: 46,
								color: primitiveColors[primitive.id],
							}}
						>
							{primitive.word}
						</div>
					</div>
				)
			})}
		</>
	)
}

type PanelRow = { mark?: MarkId; name: string; detail: string }

const secretRows: ReadonlyArray<PanelRow> = [
	{ name: 'stripe-secret-key', detail: '••••••••' },
	{ name: 'linear-api-key', detail: '••••••••' },
	{ name: 'github-app-key', detail: '••••••••' },
]

const connectionRows: ReadonlyArray<PanelRow> = [
	{ mark: 'google', name: 'Google', detail: 'Gmail · Calendar' },
	{ mark: 'github', name: 'GitHub', detail: 'kentcdodds' },
	{ mark: 'slack', name: 'Slack', detail: 'Workspace' },
	{ mark: 'stripe', name: 'Stripe', detail: 'Live mode' },
]

function Panel({
	frame,
	side,
	title,
	color,
	rows,
	footer,
}: {
	frame: number
	side: 'left' | 'right'
	title: string
	color: string
	rows: ReadonlyArray<PanelRow>
	footer: string
}) {
	const show = settle(frame, panelsIn, { damping: 18, stiffness: 100 })
	const fade = 1 - progress(frame, sceneOut, sceneOut + 14, easeIn)
	const centerX = side === 'left' ? 356 : 1564
	const panelWidth = 480
	const fromX = mix(960 - centerX, 0, show)
	return (
		<div
			style={{
				position: 'absolute',
				left: centerX - panelWidth / 2,
				top: 452 - 190,
				width: panelWidth,
				padding: '26px 28px',
				borderRadius: 24,
				background: 'oklch(0.21 0.01 255 / 0.92)',
				border: `1.5px solid ${color}`,
				boxShadow: `0 30px 70px oklch(0 0 0 / 0.5), 0 0 40px oklch(0 0 0 / 0.2), 0 0 0 6px color-mix(in oklch, ${color} 10%, transparent)`,
				fontFamily: fonts.body,
				color: colors.text,
				opacity: Math.min(1, show * 1.3) * fade,
				transform: `translateX(${fromX}px) scale(${mix(0.6, 1, show)})`,
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 12,
					fontFamily: fonts.display,
					fontWeight: 700,
					fontSize: 32,
					color,
				}}
			>
				<div
					style={{
						width: 14,
						height: 14,
						borderRadius: '50%',
						background: color,
						boxShadow: `0 0 14px ${color}`,
					}}
				/>
				{title}
				<span
					style={{
						marginLeft: 'auto',
						fontFamily: fonts.body,
						fontWeight: 600,
						fontSize: 17,
						color: colors.textMuted,
					}}
				>
					in Kody
				</span>
			</div>
			<div style={{ marginTop: 18, display: 'grid', gap: 12 }}>
				{rows.map((row, index) => {
					const rowShow = settle(frame, panelsIn + 8 + index * 4)
					return (
						<div
							key={row.name}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 14,
								padding: '10px 14px',
								borderRadius: 14,
								background: colors.surface,
								opacity: rowShow,
								transform: `translateY(${mix(14, 0, rowShow)}px)`,
							}}
						>
							{row.mark ? (
								<MarkWell id={row.mark} size={38} />
							) : (
								<div
									style={{
										width: 38,
										height: 38,
										borderRadius: 10,
										display: 'grid',
										placeItems: 'center',
										background: 'oklch(0.72 0.19 300 / 0.18)',
										color,
										fontSize: 20,
									}}
								>
									<LockGlyph color={color} />
								</div>
							)}
							<div
								style={{
									fontSize: 20,
									fontWeight: 600,
									fontFamily: row.mark ? fonts.body : fonts.mono,
									whiteSpace: 'nowrap',
								}}
							>
								{row.name}
							</div>
							<div
								style={{
									marginLeft: 'auto',
									fontSize: 17,
									color: row.mark ? colors.primaryText : colors.textMuted,
									fontWeight: 600,
									whiteSpace: 'nowrap',
								}}
							>
								{row.mark ? `✓ ${row.detail}` : row.detail}
							</div>
						</div>
					)
				})}
			</div>
			<div
				style={{
					marginTop: 16,
					fontSize: 18,
					color: colors.textMuted,
					opacity: progress(frame, panelsIn + 24, panelsIn + 36),
				}}
			>
				{footer}
			</div>
		</div>
	)
}

function LockGlyph({ color }: { color: string }) {
	return (
		<svg width={20} height={20} viewBox="0 0 24 24" aria-hidden="true">
			<rect x="4" y="10" width="16" height="11" rx="3" fill={color} />
			<path
				d="M8 10V7a4 4 0 0 1 8 0v3"
				fill="none"
				stroke={color}
				strokeWidth="2.4"
			/>
		</svg>
	)
}

function PanelBeams({ frame }: { frame: number }) {
	const pose = lanternPose(frame)
	const draw = progress(frame, panelsIn + 6, panelsIn + 22)
	const fade = 1 - progress(frame, sceneOut, sceneOut + 14, easeIn)
	return (
		<svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
			<Beam
				from={orbCenter(pose, 'secrets', frame)}
				to={{ x: 356 + 240, y: 452 }}
				bend={0.1}
				color={primitiveColors.secrets}
				draw={draw}
				flow={frame / 6}
				opacity={fade}
			/>
			<Beam
				from={orbCenter(pose, 'integrations', frame)}
				to={{ x: 1564 - 240, y: 452 }}
				bend={-0.1}
				color={primitiveColors.integrations}
				draw={draw}
				flow={frame / 6}
				opacity={fade}
			/>
		</svg>
	)
}

export function ConnectOnce() {
	const frame = useCurrentFrame() + scenes.connectOnce.from
	return (
		<AbsoluteFill>
			<PrimitiveLabels frame={frame} />
			<PanelBeams frame={frame} />
			<Panel
				frame={frame}
				side="left"
				title="Secrets"
				color={primitiveColors.secrets}
				rows={secretRows}
				footer="Your software uses them. Agents never see them."
			/>
			<Panel
				frame={frame}
				side="right"
				title="Connections"
				color={primitiveColors.integrations}
				rows={connectionRows}
				footer="Signed in once. Reused by every app."
			/>
			<Headline
				frame={frame}
				lines={[
					[
						...words('Connect once.'),
						...words('Keep them in').map((word, index) => ({
							...word,
							at: bar(7, 1) + index * 3,
						})),
						{ text: 'Kody.', color: colors.primary, at: bar(7, 2) },
					],
				]}
				enterAt={bar(6, 1)}
				exitAt={sceneOut}
				stagger={4}
				fontSize={84}
				align="center"
				style={{ left: 0, right: 0, top: 846 }}
			/>
		</AbsoluteFill>
	)
}

const arrivalLabels: Partial<Record<MarkId, string>> = {
	stripe: 'Stripe key',
	linear: 'Linear key',
}

/** Drawn above the lantern so marks visibly drop into the glass. */
export function ArrivalsOverlay() {
	const frame = useCurrentFrame() + scenes.connectOnce.from
	const pose = lanternPose(frame)
	return (
		<AbsoluteFill>
			{arrivals.map((arrival, index) => {
				const start = arrival.at - flightFrames
				if (frame < start || frame > arrival.at + 2) return null
				const target = orbCenter(pose, arrival.orb, frame)
				const control = {
					x:
						mix(arrival.from.x, target.x, 0.2) +
						(index % 2 === 0 ? -1 : 1) * 160,
					y: Math.min(arrival.from.y, target.y) - 180,
				}
				const t = progress(frame, start, arrival.at, easeInOut)
				const point = quadraticPoint(arrival.from, control, target, t)
				const size = mix(88, 22, t ** 1.6)
				const color = primitiveColors[arrival.orb]
				const trail = Array.from({ length: 12 }, (_, step) => {
					const trailT = Math.max(0, t - (step + 1) * 0.035)
					return {
						point: quadraticPoint(arrival.from, control, target, trailT),
						strength: (1 - step / 12) * (trailT > 0 ? 1 : 0),
					}
				})
				const opacity =
					progress(frame, start, start + 6) *
					(1 - progress(frame, arrival.at - 3, arrival.at + 2))
				return (
					<div key={arrival.mark + arrival.at} style={{ opacity }}>
						{trail.map((dot, step) => (
							<div
								key={step}
								style={{
									position: 'absolute',
									left: dot.point.x - 7,
									top: dot.point.y - 7,
									width: 14,
									height: 14,
									borderRadius: '50%',
									background: color,
									opacity: dot.strength * 0.55,
									transform: `scale(${dot.strength})`,
									filter: 'blur(2px)',
								}}
							/>
						))}
						<div
							style={{
								position: 'absolute',
								left: point.x - size / 2,
								top: point.y - size / 2,
								filter: `drop-shadow(0 0 ${18 * t}px ${color})`,
							}}
						>
							<MarkWell id={arrival.mark} size={size} />
						</div>
						<div
							style={{
								position: 'absolute',
								left: point.x,
								top: point.y + size / 2 + 10,
								transform: 'translateX(-50%)',
								padding: '5px 14px',
								borderRadius: 999,
								background: 'oklch(0.2 0.01 255 / 0.85)',
								border: `1px solid ${color}`,
								color,
								fontFamily: fonts.body,
								fontWeight: 700,
								fontSize: 18,
								whiteSpace: 'nowrap',
								opacity: presence(frame, {
									in: start + 2,
									out: arrival.at - 16,
									enter: 8,
									exit: 8,
								}),
							}}
						>
							{arrivalLabels[arrival.mark] ?? arrival.label}
						</div>
					</div>
				)
			})}
		</AbsoluteFill>
	)
}
