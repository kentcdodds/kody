import {
	BufferAttribute,
	BufferGeometry,
	Color,
	Points,
	type ShaderMaterial,
} from 'three'
import { type Vec3 } from './lantern-3d-motion.ts'

/**
 * The lantern's idle moment. After a quiet spell a thread of light runs
 * orb to orb in the order the words are listed, like the constellation in
 * Kody's own lantern, and each orb chimes as the light reaches it. The
 * thread holds, fades, and comes back now and then while the visitor keeps
 * watching. Anything the visitor does starts the quiet over.
 */

export const constellationTiming = {
	/** Seconds of quiet before the first showing. */
	first: 10,
	/** Seconds from one showing to the next while it stays quiet. */
	every: 30,
	/** Seconds for the light to run from one orb to the next. */
	leg: 0.6,
	/** Seconds the drawn thread holds before it fades. */
	hold: 0.9,
	fade: 1.8,
} as const

export type ConstellationMoment = {
	/** How far the light has run, in legs: 0 at the first orb. */
	head: number
	/** How much of the whole thread is lit once the light has run it:
	 *  0 while it runs, 1 by the end of the hold. */
	settle: number
	/** Brightness of the whole thread, down to 0 as it fades. */
	glow: number
}

/** The thread `quiet` seconds into a quiet spell, or null between
 *  showings. */
export function constellationAt(
	quiet: number,
	legs: number,
): ConstellationMoment | null {
	const { first, every, leg, hold, fade } = constellationTiming
	if (quiet < first) return null
	const into = (quiet - first) % every
	const run = legs * leg
	if (into >= run + hold + fade) return null
	return {
		head: Math.min(into / leg, legs),
		settle: Math.min(Math.max((into - run) / hold, 0), 1),
		glow: Math.min(1, 1 - (into - run - hold) / fade),
	}
}

/** The stops the light reached after `previous` and by `head`, so each
 *  orb chimes once. `previous` is null on a showing's first frame. */
export function constellationArrivals(
	previous: number | null,
	head: number,
): Array<number> {
	const arrivals: Array<number> = []
	const from = previous === null ? 0 : Math.floor(previous) + 1
	for (let stop = from; stop <= Math.floor(head); stop++) arrivals.push(stop)
	return arrivals
}

export type ConstellationStop = Vec3 & { radius: number }

/** Legs start and end this far out from an orb's centre, in radii. */
const rimReach = 1.15
const motesPerLeg = 96

/** Each leg runs from just outside one orb to just outside the next, so
 *  the thread never crosses a glyph. Overlapping orbs get no line. */
export function constellationLeg(
	from: ConstellationStop,
	to: ConstellationStop,
	share: number,
): Vec3 | null {
	const dx = to.x - from.x
	const dy = to.y - from.y
	const dz = to.z - from.z
	const length = Math.hypot(dx, dy, dz)
	const start = from.radius * rimReach
	const end = length - to.radius * rimReach
	if (end <= start) return null
	const along = (start + (end - start) * share) / length
	return {
		x: from.x + dx * along,
		y: from.y + dy * along,
		z: from.z + dz * along,
	}
}

export type ConstellationThread = {
	points: Points<BufferGeometry, ShaderMaterial>
	/** Lays the thread through `stops`, in order. */
	place: (stops: ReadonlyArray<ConstellationStop>) => void
	/** Tints each leg from one orb's color to the next, linear sRGB. */
	paint: (colors: ReadonlyArray<Color>) => void
}

export function createConstellationThread(
	material: ShaderMaterial,
	legs: number,
): ConstellationThread {
	const count = legs * motesPerLeg
	const positions = new BufferAttribute(new Float32Array(count * 3), 3)
	const colors = new BufferAttribute(new Float32Array(count * 3), 3)
	const along = new Float32Array(count)
	for (let leg = 0; leg < legs; leg++) {
		for (let mote = 0; mote < motesPerLeg; mote++) {
			along[leg * motesPerLeg + mote] = leg + mote / (motesPerLeg - 1)
		}
	}
	const geometry = new BufferGeometry()
	geometry.setAttribute('position', positions)
	geometry.setAttribute('aColor', colors)
	geometry.setAttribute('aAlong', new BufferAttribute(along, 1))
	const points = new Points(geometry, material)
	points.frustumCulled = false
	points.visible = false
	const tint = new Color()
	const white = new Color(1, 1, 1)

	return {
		points,
		place(stops) {
			for (let leg = 0; leg < legs; leg++) {
				const from = stops[leg]
				const to = stops[leg + 1]
				for (let mote = 0; mote < motesPerLeg; mote++) {
					const index = leg * motesPerLeg + mote
					const share = mote / (motesPerLeg - 1)
					const at = from && to ? constellationLeg(from, to, share) : null
					// Parked beyond the camera's far plane when there is no line.
					if (at) positions.setXYZ(index, at.x, at.y, at.z)
					else positions.setXYZ(index, 0, 0, -100)
				}
			}
			positions.needsUpdate = true
		},
		paint(palette) {
			for (let leg = 0; leg < legs; leg++) {
				const from = palette[leg] ?? white
				const to = palette[leg + 1] ?? white
				for (let mote = 0; mote < motesPerLeg; mote++) {
					tint
						.copy(from)
						.lerp(to, mote / (motesPerLeg - 1))
						.lerp(white, 0.15)
					colors.setXYZ(leg * motesPerLeg + mote, tint.r, tint.g, tint.b)
				}
			}
			colors.needsUpdate = true
		},
	}
}
