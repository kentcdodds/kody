import { AbsoluteFill, Img, useCurrentFrame } from 'remotion'
import {
	landingLanternGlass,
	landingLanternOrbClipPath,
	landingLanternOrbs,
	type LandingPrimitiveId,
} from '../../../../worker/universal/landing-lantern.ts'
import { lanternArt, orbArt } from '../assets.ts'
import { cues, orbPulses } from '../choreography.ts'
import {
	easeInOut,
	mix,
	progress,
	pulse,
	settle,
	type Point,
} from '../motion.ts'
import { colors, primitiveColors } from '../theme.ts'

export type LanternPose = {
	x: number
	y: number
	height: number
	width: number
	opacity: number
	glow: number
}

const aspect = lanternArt.width / lanternArt.height

const stations = {
	home: { x: 960, y: 452, height: 590 },
	side: { x: 318, y: 640, height: 440 },
	close: { x: 960, y: 368, height: 470 },
}

/** Where the lantern is on a given frame. Beats 2–4 share this one track. */
export function lanternPose(frame: number): LanternPose {
	const toSide = progress(
		frame,
		cues.lanternToSide.start,
		cues.lanternToSide.end,
		easeInOut,
	)
	const toClose = progress(
		frame,
		cues.lanternToCenter.start,
		cues.lanternToCenter.end,
		easeInOut,
	)
	const lerp = (key: 'x' | 'y' | 'height') =>
		mix(
			mix(stations.home[key], stations.side[key], toSide),
			stations.close[key],
			toClose,
		)
	const arrive = settle(frame, cues.lanternAppear, {
		damping: 16,
		stiffness: 90,
	})
	const height = lerp('height') * mix(0.84, 1, arrive)
	const flash = pulse(frame, cues.lanternAppear + 2, 34)
	const finalBloom = pulse(frame, cues.finalChord, 50)
	return {
		x: lerp('x'),
		y: lerp('y') + (1 - arrive) * 60,
		height,
		width: height * aspect,
		opacity: progress(frame, cues.lanternAppear, cues.lanternAppear + 10),
		glow: 0.85 + flash * 0.9 + finalBloom * 0.5,
	}
}

function orbLayout(id: LandingPrimitiveId) {
	const orb = landingLanternOrbs.find((candidate) => candidate.id === id)
	if (!orb) throw new Error(`Unknown orb ${id}`)
	return orb
}

function orbDrift(frame: number, index: number) {
	return {
		x: Math.sin(frame / 23 + index * 1.7) * 0.9,
		y: Math.cos(frame / 29 + index * 2.3) * 0.8,
	}
}

export function orbCenter(
	pose: LanternPose,
	id: LandingPrimitiveId,
	frame: number,
): Point {
	const orb = orbLayout(id)
	const index = landingLanternOrbs.indexOf(orb)
	const drift = orbDrift(frame, index)
	return {
		x: pose.x - pose.width / 2 + ((orb.x + drift.x) / 100) * pose.width,
		y: pose.y - pose.height / 2 + ((orb.y + drift.y) / 100) * pose.height,
	}
}

export function orbPulse(frame: number, id: LandingPrimitiveId) {
	let value = 0
	for (const entry of orbPulses) {
		if (entry.orb !== id) continue
		value = Math.max(value, pulse(frame, entry.at, 20))
	}
	return value
}

export function Lantern() {
	const frame = useCurrentFrame()
	if (frame < cues.lanternAppear - 1) return null
	const pose = lanternPose(frame)
	const left = pose.x - pose.width / 2
	const top = pose.y - pose.height / 2
	const glassX = left + pose.width * landingLanternGlass.x
	const glassY = top + pose.height * landingLanternGlass.y
	const glowRadius = pose.width * 1.35

	return (
		<AbsoluteFill style={{ opacity: pose.opacity, pointerEvents: 'none' }}>
			<div
				style={{
					position: 'absolute',
					left: glassX - glowRadius,
					top: glassY - glowRadius,
					width: glowRadius * 2,
					height: glowRadius * 2,
					borderRadius: '50%',
					background: `radial-gradient(circle, ${colors.lanternGlow} 0%, oklch(0.8 0.13 80 / 0.18) 34%, transparent 68%)`,
					opacity: Math.min(1, pose.glow * 0.75),
					transform: `scale(${0.9 + pose.glow * 0.12})`,
				}}
			/>
			<div
				style={{
					position: 'absolute',
					left,
					top,
					width: pose.width,
					height: pose.height,
					filter: `drop-shadow(0 30px 60px oklch(0 0 0 / 0.55)) brightness(${0.94 + pose.glow * 0.08})`,
				}}
			>
				<Img
					src={lanternArt.still}
					style={{ width: '100%', height: '100%', display: 'block' }}
				/>
				<div
					style={{
						position: 'absolute',
						inset: 0,
						clipPath: landingLanternOrbClipPath(),
					}}
				>
					{landingLanternOrbs.map((orb, index) => {
						const lit = settle(frame, cues.orbLit[orb.id], {
							damping: 12,
							stiffness: 150,
						})
						const beat = orbPulse(frame, orb.id)
						const drift = orbDrift(frame, index)
						const size = (orb.art / 100) * pose.width
						return (
							<div
								key={orb.id}
								style={{
									position: 'absolute',
									left: `${orb.x + drift.x}%`,
									top: `${orb.y + drift.y}%`,
									width: size,
									height: size,
									marginLeft: -size / 2,
									marginTop: -size / 2,
									opacity: Math.min(1, lit * 1.4),
									transform: `scale(${mix(0.3, 1, lit) * (1 + beat * 0.16)})`,
									filter: `brightness(${1 + beat * 0.45}) drop-shadow(0 0 ${6 + beat * 22}px ${primitiveColors[orb.id]})`,
								}}
							>
								<Img
									src={orbArt[orb.id]}
									style={{ width: '100%', height: '100%', display: 'block' }}
								/>
							</div>
						)
					})}
				</div>
			</div>
			{landingLanternOrbs.map((orb) => {
				const beat = orbPulse(frame, orb.id)
				if (beat <= 0.001) return null
				const center = orbCenter(pose, orb.id, frame)
				const size = (orb.size / 100) * pose.width
				let age = 1
				for (const entry of orbPulses) {
					if (entry.orb !== orb.id) continue
					if (frame >= entry.at && frame <= entry.at + 20) {
						age = (frame - entry.at) / 20
					}
				}
				const ringScale = mix(1, 2.6, age)
				return (
					<div
						key={orb.id}
						style={{
							position: 'absolute',
							left: center.x - size / 2,
							top: center.y - size / 2,
							width: size,
							height: size,
							borderRadius: '50%',
							border: `3px solid ${primitiveColors[orb.id]}`,
							opacity: (1 - age) * 0.9,
							transform: `scale(${ringScale})`,
							boxShadow: `0 0 24px ${primitiveColors[orb.id]}`,
						}}
					/>
				)
			})}
		</AbsoluteFill>
	)
}
