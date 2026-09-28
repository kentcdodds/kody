import { type Point } from '../motion.ts'

/**
 * Leader-line look from the homepage primitives section: a soft halo, a
 * base stroke, and a dashed flow that runs from the lantern outward.
 * `draw` reveals the path from its start; `flow` advances the dashes.
 */
export function Beam({
	from,
	to,
	bend = 0.18,
	color,
	draw,
	flow,
	opacity = 1,
	width = 3,
}: {
	from: Point
	to: Point
	bend?: number
	color: string
	draw: number
	flow: number
	opacity?: number
	width?: number
}) {
	const dx = to.x - from.x
	const dy = to.y - from.y
	const control = {
		x: from.x + dx / 2 - dy * bend,
		y: from.y + dy / 2 + dx * bend,
	}
	const d = `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`
	const length = Math.hypot(dx, dy) * (1 + Math.abs(bend) * 0.6)
	if (draw <= 0 || opacity <= 0) return null
	return (
		<g opacity={opacity}>
			<path
				d={d}
				fill="none"
				stroke={color}
				strokeWidth={width * 5}
				strokeLinecap="round"
				opacity={0.14}
				strokeDasharray={length}
				strokeDashoffset={length * (1 - draw)}
			/>
			<path
				d={d}
				fill="none"
				stroke={color}
				strokeWidth={width}
				strokeLinecap="round"
				opacity={0.55}
				strokeDasharray={length}
				strokeDashoffset={length * (1 - draw)}
			/>
			{draw >= 1 ? (
				<path
					d={d}
					fill="none"
					stroke="white"
					strokeWidth={width * 0.9}
					strokeLinecap="round"
					opacity={0.75}
					strokeDasharray="4 26"
					strokeDashoffset={-flow * 30}
				/>
			) : null}
		</g>
	)
}
