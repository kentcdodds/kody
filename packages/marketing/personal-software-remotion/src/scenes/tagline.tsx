import { AbsoluteFill, Img, useCurrentFrame } from 'remotion'
import { landingLanternGlass } from '../../../../worker/universal/landing-lantern.ts'
import { brandArt } from '../assets.ts'
import { Headline, words } from '../components/headline.tsx'
import { lanternPose } from '../components/lantern.tsx'
import { MarkWell, type MarkId } from '../components/mark.tsx'
import { cues } from '../choreography.ts'
import { easeOut, mix, progress, settle } from '../motion.ts'
import { colors, fonts, primitiveColors } from '../theme.ts'
import { scenes } from '../timing.ts'

const ring: ReadonlyArray<MarkId> = [
	'google',
	'github',
	'cursor',
	'slack',
	'stripe',
	'claude',
	'linear',
	'spotify',
	'chatgpt',
	'codex',
	'gemini',
]

const ringColors = Object.values(primitiveColors)

function ringPlacement(frame: number, index: number) {
	const pose = lanternPose(frame)
	const center = {
		x: pose.x,
		y: pose.y - pose.height / 2 + pose.height * landingLanternGlass.y,
	}
	const spread = settle(frame, cues.lanternToCenter.start + 8 + index * 2, {
		damping: 20,
		stiffness: 70,
	})
	const angle =
		(index / ring.length) * Math.PI * 2 + frame * 0.0065 - Math.PI / 2
	const depth = Math.sin(angle)
	return {
		center,
		x: center.x + Math.cos(angle) * 640 * spread,
		y: center.y + depth * 225 * spread,
		depth,
		spread,
	}
}

/**
 * Everything the home is connected to, orbiting the lantern. Split into a
 * back layer (under the lantern) and a front layer (over it) for depth.
 */
export function TaglineRing({ layer }: { layer: 'back' | 'front' }) {
	const frame = useCurrentFrame() + scenes.tagline.from
	return (
		<AbsoluteFill>
			{layer === 'back' ? (
				<svg
					width={1920}
					height={1080}
					style={{ position: 'absolute', inset: 0 }}
				>
					{ring.map((mark, index) => {
						const place = ringPlacement(frame, index)
						return (
							<line
								key={mark}
								x1={place.center.x}
								y1={place.center.y}
								x2={place.x}
								y2={place.y}
								stroke={ringColors[index % ringColors.length]}
								strokeWidth={2}
								opacity={place.spread * mix(0.18, 0.4, (place.depth + 1) / 2)}
							/>
						)
					})}
				</svg>
			) : null}
			{ring.map((mark, index) => {
				const place = ringPlacement(frame, index)
				const inFront = place.depth > 0
				if ((layer === 'front') !== inFront) return null
				const scale = mix(0.72, 1.08, (place.depth + 1) / 2)
				const size = 66 * scale
				return (
					<div
						key={mark}
						style={{
							position: 'absolute',
							left: place.x - size / 2,
							top: place.y - size / 2,
							opacity:
								Math.min(1, place.spread * 1.3) *
								mix(0.55, 1, (place.depth + 1) / 2),
							filter: `drop-shadow(0 0 14px ${ringColors[index % ringColors.length]})`,
						}}
					>
						<MarkWell id={mark} size={size} />
					</div>
				)
			})}
		</AbsoluteFill>
	)
}

export function Tagline() {
	const frame = useCurrentFrame() + scenes.tagline.from
	const lockup = settle(frame, cues.finalChord + 36, {
		damping: 18,
		stiffness: 110,
	})
	return (
		<AbsoluteFill>
			<Headline
				frame={frame}
				lines={[
					words('Personal software,'),
					words('connected to everything.', colors.primary).map(
						(word, index) => ({
							...word,
							at: cues.finalChord + 14 + index * 4,
						}),
					),
				]}
				enterAt={cues.finalChord + 2}
				stagger={4}
				fontSize={94}
				align="center"
				style={{ left: 0, right: 0, top: 684 }}
			/>
			<div
				style={{
					position: 'absolute',
					left: 0,
					right: 0,
					top: 928,
					display: 'flex',
					justifyContent: 'center',
					alignItems: 'center',
					gap: 18,
					opacity: progress(
						frame,
						cues.finalChord + 36,
						cues.finalChord + 48,
						easeOut,
					),
					transform: `translateY(${mix(20, 0, lockup)}px)`,
				}}
			>
				<Img src={brandArt.kodyLogo} style={{ width: 72, height: 72 }} />
				<div
					style={{
						fontFamily: fonts.display,
						fontWeight: 700,
						fontSize: 48,
						color: colors.text,
						letterSpacing: '-0.01em',
					}}
				>
					kody.codes
				</div>
			</div>
		</AbsoluteFill>
	)
}
