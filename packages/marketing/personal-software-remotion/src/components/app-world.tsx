import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { landingLanternGlass } from '../../../../worker/universal/landing-lantern.ts'
import {
	appTiles,
	camera,
	firstAppTile,
	fromRestScreen,
	tickTargets,
	tileSize,
	toScreen,
	worldOriginAtRest,
	type AppTile,
	type Camera,
} from '../app-grid.ts'
import { cardFetches, cues, triggerTicks } from '../choreography.ts'
import { easeInOut, mix, progress, pulse, settle } from '../motion.ts'
import { colors, fonts, primitiveColors } from '../theme.ts'
import { scenes } from '../timing.ts'
import { AppWindow } from './app-window.tsx'
import { Beam } from './beam.tsx'
import { lanternPose, orbCenter } from './lantern.tsx'
import { MarkWell } from './mark.tsx'
import { cardPort, ClockGlyph, PersonalApp } from './personal-app.tsx'

function useWorldFrame() {
	return useCurrentFrame() + scenes.appWorld.from
}

/** Dims the grid behind the tagline so the close stays legible. */
function closeDim(frame: number) {
	return progress(
		frame,
		cues.lanternToCenter.start,
		cues.lanternToCenter.end,
		easeInOut,
	)
}

const barHeights = [0.42, 0.7, 0.55, 0.86, 0.64, 0.93, 0.78]
const sparkValues = [0.3, 0.46, 0.4, 0.62, 0.55, 0.78, 0.7, 0.9]

function MiniChart({ tile }: { tile: AppTile }) {
	const accent = Object.values(primitiveColors)[tile.index % 6]!
	if (tile.kind === 'bars') {
		return (
			<div
				style={{
					display: 'flex',
					alignItems: 'flex-end',
					gap: 26,
					height: 230,
				}}
			>
				{barHeights.map((value, index) => (
					<div
						key={index}
						style={{
							flex: 1,
							height: `${value * 100}%`,
							borderRadius: 16,
							background: accent,
							opacity: 0.35 + value * 0.6,
						}}
					/>
				))}
			</div>
		)
	}
	if (tile.kind === 'spark') {
		const w = 1070
		const h = 230
		const d = sparkValues
			.map(
				(value, index) =>
					`${index === 0 ? 'M' : 'L'} ${(index / (sparkValues.length - 1)) * w} ${h - value * h}`,
			)
			.join(' ')
		return (
			<svg width={w} height={h} style={{ display: 'block' }}>
				<path d={`${d} L ${w} ${h} L 0 ${h} Z`} fill={accent} opacity={0.18} />
				<path
					d={d}
					fill="none"
					stroke={accent}
					strokeWidth={12}
					strokeLinejoin="round"
				/>
			</svg>
		)
	}
	return (
		<div style={{ display: 'grid', gap: 22 }}>
			{[0.86, 0.64, 0.74].map((share, index) => (
				<div
					key={index}
					style={{ display: 'flex', alignItems: 'center', gap: 22 }}
				>
					<div
						style={{
							width: 44,
							height: 44,
							borderRadius: 12,
							background: accent,
							opacity: 0.8,
						}}
					/>
					<div
						style={{
							width: `${share * 100}%`,
							height: 40,
							borderRadius: 20,
							background: colors.surfaceRaised,
						}}
					/>
				</div>
			))}
		</div>
	)
}

function MiniApp({ tile, frame }: { tile: AppTile; frame: number }) {
	if (frame < tile.spawnAt - 1) return null
	const appear = settle(frame, tile.spawnAt, { damping: 15, stiffness: 180 })
	const flash = pulse(frame, tile.spawnAt, 16)
	return (
		<AppWindow
			width={tileSize.width}
			height={tileSize.height}
			title={tile.name}
			address={`kent.kody.run/packages/${tile.slug}`}
			accent={flash > 0.05 ? primitiveColors.apps : undefined}
			style={{
				left: tile.center.x - tileSize.width / 2,
				top: tile.center.y - tileSize.height / 2,
				opacity: Math.min(1, appear * 1.6),
				transform: `scale(${mix(0.7, 1, appear)})`,
				boxShadow: `0 40px 90px oklch(0 0 0 / 0.55), 0 0 ${flash * 160}px ${primitiveColors.apps}`,
			}}
		>
			<div style={{ position: 'absolute', inset: 0, padding: '44px 60px' }}>
				<div style={{ display: 'flex', alignItems: 'baseline', gap: 28 }}>
					<div
						style={{
							fontFamily: fonts.display,
							fontWeight: 800,
							fontSize: 120,
						}}
					>
						{tile.stat}
					</div>
					<div style={{ fontSize: 44, color: colors.textMuted }}>
						{tile.caption}
					</div>
				</div>
				<div style={{ marginTop: 34 }}>
					<MiniChart tile={tile} />
				</div>
				<div
					style={{
						position: 'absolute',
						left: 60,
						right: 60,
						bottom: 44,
						display: 'flex',
						alignItems: 'center',
						gap: 20,
					}}
				>
					{tile.marks.map((mark) => (
						<MarkWell key={mark} id={mark} size={84} />
					))}
					<div
						style={{
							marginLeft: 16,
							display: 'flex',
							alignItems: 'center',
							gap: 16,
							fontSize: 40,
							fontWeight: 700,
							color: primitiveColors.integrations,
						}}
					>
						<div
							style={{
								width: 22,
								height: 22,
								borderRadius: '50%',
								background: primitiveColors.integrations,
							}}
						/>
						via Kody
					</div>
				</div>
			</div>
		</AppWindow>
	)
}

function tileScreenRect(view: Camera, center: { x: number; y: number }) {
	const screen = toScreen(view, center)
	return {
		x: screen.x,
		y: screen.y,
		width: tileSize.width * view.scale,
		height: tileSize.height * view.scale,
	}
}

/** Lantern → every app. Drawn under the world so tiles cover the line ends. */
export function AppWorldBeams() {
	const frame = useWorldFrame()
	if (frame < cues.appBuild - 6) return null
	const view = camera(frame)
	const pose = lanternPose(frame)
	const hub = {
		x: pose.x,
		y: pose.y - pose.height / 2 + pose.height * landingLanternGlass.y,
	}
	const zooming = progress(frame, cues.zoomOut.start, cues.zoomOut.start + 20)
	const cardBeams = 1 - zooming
	const dim = mix(1, 0.3, closeDim(frame))
	return (
		<svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
			<Beam
				from={orbCenter(pose, 'apps', frame)}
				to={fromRestScreen(view, { x: 594, y: 286 + 120 })}
				bend={-0.16}
				color={primitiveColors.apps}
				draw={progress(frame, cues.appBuild - 4, cues.appBuild + 10)}
				flow={frame / 7}
				opacity={cardBeams}
			/>
			{cardFetches.map((at, index) => (
				<Beam
					key={at}
					from={orbCenter(pose, 'integrations', frame)}
					to={fromRestScreen(view, cardPort(index))}
					bend={0.06 + index * 0.02}
					color={primitiveColors.integrations}
					draw={progress(frame, at - 12, at)}
					flow={frame / 6 + index}
					opacity={cardBeams * 0.9}
					width={2.5}
				/>
			))}
			{[
				{
					center: firstAppTile.center,
					spawnAt: cues.zoomOut.start + 4,
					index: -1,
				},
				...appTiles,
			].map((tile) => {
				const rect = tileScreenRect(view, tile.center)
				return (
					<Beam
						key={tile.index}
						from={hub}
						to={{ x: rect.x, y: rect.y }}
						bend={0}
						color={primitiveColors.integrations}
						draw={progress(frame, tile.spawnAt - 2, tile.spawnAt + 8)}
						flow={frame / 5 + tile.index * 0.37}
						opacity={0.55 * dim}
						width={2}
					/>
				)
			})}
			{triggerTicks.map((tick, tickIndex) =>
				tickTargets(tickIndex).map((tile) => {
					const rect = tileScreenRect(view, tile.center)
					return (
						<Beam
							key={`${tick}-${tile.index}`}
							from={orbCenter(pose, 'triggers', frame)}
							to={{ x: rect.x, y: rect.y }}
							bend={0}
							color={primitiveColors.triggers}
							draw={progress(frame, tick - 4, tick + 4)}
							flow={frame / 4}
							opacity={1 - progress(frame, tick + 10, tick + 22)}
							width={2.5}
						/>
					)
				}),
			)}
		</svg>
	)
}

/** The first app plus every app spawned from the same home, under one camera. */
export function AppWorld() {
	const frame = useWorldFrame()
	if (frame < cues.appBuild - 2) return null
	const view = camera(frame)
	const dim = closeDim(frame)
	return (
		<AbsoluteFill style={{ opacity: mix(1, 0.22, dim) }}>
			<div
				style={{
					position: 'absolute',
					left: 0,
					top: 0,
					width: 0,
					height: 0,
					transformOrigin: '0 0',
					transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
				}}
			>
				<div
					style={{
						position: 'absolute',
						left: -worldOriginAtRest.x,
						top: -worldOriginAtRest.y,
					}}
				>
					<PersonalApp frame={frame} />
				</div>
				{appTiles.map((tile) => (
					<MiniApp key={tile.index} tile={tile} frame={frame} />
				))}
			</div>
		</AbsoluteFill>
	)
}

/** Screen-space glow and clock badge on the apps a trigger just woke. */
export function TriggerFlashes() {
	const frame = useWorldFrame()
	const view = camera(frame)
	return (
		<AbsoluteFill>
			{triggerTicks.map((tick, tickIndex) => {
				const strength = pulse(frame, tick + 2, 26)
				if (strength <= 0.01) return null
				return tickTargets(tickIndex).map((tile) => {
					const rect = tileScreenRect(view, tile.center)
					return (
						<div
							key={`${tick}-${tile.index}`}
							style={{
								position: 'absolute',
								left: rect.x - rect.width / 2,
								top: rect.y - rect.height / 2,
								width: rect.width,
								height: rect.height,
								borderRadius: 22 * view.scale + 3,
								border: `2.5px solid ${primitiveColors.triggers}`,
								boxShadow: `0 0 ${24 * strength}px ${primitiveColors.triggers}`,
								opacity: strength,
							}}
						>
							<div
								style={{
									position: 'absolute',
									right: -12,
									top: -12,
									width: 30,
									height: 30,
									borderRadius: '50%',
									display: 'grid',
									placeItems: 'center',
									background: colors.canvas,
									border: `2px solid ${primitiveColors.triggers}`,
									transform: `scale(${mix(0.6, 1, strength)})`,
								}}
							>
								<ClockGlyph color={primitiveColors.triggers} size={18} />
							</div>
						</div>
					)
				})
			})}
		</AbsoluteFill>
	)
}

/** Keeps the headline readable while tiles fill the top of the frame. */
export function HeadlineScrim() {
	const frame = useWorldFrame()
	const show = progress(frame, cues.zoomOut.start, cues.zoomOut.start + 30)
	const dim = closeDim(frame)
	return (
		<AbsoluteFill
			style={{
				opacity: show * (1 - dim),
				background: `linear-gradient(180deg, ${colors.canvas} 0%, oklch(0.155 0.01 255 / 0.96) 236px, transparent 300px)`,
			}}
		/>
	)
}
