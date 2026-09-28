import { AbsoluteFill, random, useCurrentFrame } from 'remotion'
import { brandArt } from '../assets.ts'
import { cues } from '../choreography.ts'
import { progress } from '../motion.ts'
import { colors, primitiveColors } from '../theme.ts'

const palette = Object.values(primitiveColors)

const motes = Array.from({ length: 46 }, (_, index) => ({
	x: random(`mote-x-${index}`) * 1920,
	y: random(`mote-y-${index}`) * 1080,
	size: 3 + random(`mote-size-${index}`) * 9,
	speed: 0.15 + random(`mote-speed-${index}`) * 0.45,
	phase: random(`mote-phase-${index}`) * Math.PI * 2,
	color: palette[index % palette.length]!,
}))

/**
 * Night canvas behind every beat. Starts cool and flat while the viewer is
 * stuck wiring services, and warms once the lantern lights.
 */
export function Backdrop() {
	const frame = useCurrentFrame()
	const warmth = progress(frame, cues.lanternAppear, cues.lanternAppear + 40)
	const bloom = progress(frame, cues.finalChord - 10, cues.finalChord + 30)

	return (
		<AbsoluteFill style={{ background: colors.canvas, overflow: 'hidden' }}>
			<AbsoluteFill
				style={{
					background: `radial-gradient(ellipse 90% 80% at 50% 45%, oklch(0.235 0.012 255) 0%, ${colors.canvas} 70%)`,
				}}
			/>
			<AbsoluteFill
				style={{
					opacity: warmth * (0.55 + bloom * 0.25),
					background:
						'radial-gradient(ellipse 60% 55% at 50% 42%, oklch(0.42 0.09 75 / 0.32) 0%, transparent 70%)',
				}}
			/>
			<AbsoluteFill
				style={{
					opacity: 0.03,
					maskImage:
						'radial-gradient(ellipse 70% 70% at 50% 50%, transparent 25%, black 90%)',
					backgroundImage: `url(${brandArt.kodyPattern})`,
					backgroundSize: '420px 420px',
					backgroundPosition: `${frame * 0.25}px ${frame * -0.4}px`,
				}}
			/>
			{motes.map((mote, index) => {
				const y = (mote.y - frame * mote.speed * 1.4 + 1080 * 4) % 1180
				const twinkle = 0.5 + 0.5 * Math.sin(frame / 18 + mote.phase)
				return (
					<div
						key={index}
						style={{
							position: 'absolute',
							left: mote.x + Math.sin(frame / 60 + mote.phase) * 16,
							top: y - 50,
							width: mote.size,
							height: mote.size,
							borderRadius: '50%',
							background: warmth > 0 ? mote.color : colors.textMuted,
							opacity: (0.06 + warmth * 0.22) * twinkle,
							filter: `blur(${mote.size > 8 ? 3 : 1}px)`,
						}}
					/>
				)
			})}
			<AbsoluteFill
				style={{
					background:
						'radial-gradient(ellipse 120% 100% at 50% 50%, transparent 55%, oklch(0.08 0.01 255 / 0.85) 100%)',
				}}
			/>
		</AbsoluteFill>
	)
}
