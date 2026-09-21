/**
 * Soft motion for the six homepage lantern orbs.
 *
 * Coordinates are fractions of the lantern width, including y, so a circle
 * in this space is a circle in pixels (the still is taller than it is wide).
 * The motion is a lava lamp, not a pinball table: each orb eases toward a
 * slow wander target, syrup damps the velocity, and contact with another
 * orb or the inner glass only cancels the closing speed. Nothing bounces.
 */

import {
	landingLanternGlass,
	landingLanternImage,
	landingLanternOrbs,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/** Lantern height divided by width. Turns a height percent into width fractions. */
const landingLanternAspect =
	landingLanternImage.height / landingLanternImage.width

/**
 * Inner glass the orbs may swim in, as fractions of width. Inset from the
 * leader-fade circle so a disc does not cross the metal rim.
 */
export const landingLanternCavity = {
	x: landingLanternGlass.x,
	y: landingLanternGlass.y * landingLanternAspect,
	r: 0.448,
} as const

/** How far a full-motion wander target sits from the orb's home, in width fractions. */
const roam = 0.09

/** Wander angular speed, radians per second. Slow enough to read as floating. */
const wanderRate = 0.34

/** Shared swirl so the cluster drifts toward the glass and into its neighbours. */
const swirlRate = 0.1

/** Pull toward the wander target, per second. */
const spring = 1.15

/** Velocity decay, per second. High so a bump stops instead of shooting off. */
const damping = 2.6

/** Hard ceiling, width-fractions per second. The spring never needs this. */
const maxSpeed = 0.048

/** Gap between an orb's rim and the glass, so the glow does not sit on the metal. */
const wallSkin = 0.008

const phases: Record<LandingPrimitiveId, number> = {
	memory: 0.5,
	secrets: 2.05,
	packages: 3.7,
	triggers: 5.15,
	integrations: 1.15,
	apps: 6.4,
}

export type LanternOrbBody = {
	id: LandingPrimitiveId
	x: number
	y: number
	vx: number
	vy: number
	phase: number
	homeX: number
	homeY: number
	radius: number
}

/** Rest pose of one painted orb, in the motion's width-fraction space. */
function landingLanternOrbHome(orb: { x: number; y: number; size: number }) {
	return {
		x: orb.x / 100,
		y: (orb.y / 100) * landingLanternAspect,
		radius: orb.size / 200,
	}
}

export function createLanternOrbBodies(): Array<LanternOrbBody> {
	return landingLanternOrbs.map((orb) => {
		const home = landingLanternOrbHome(orb)
		return {
			id: orb.id,
			x: home.x,
			y: home.y,
			vx: 0,
			vy: 0,
			phase: phases[orb.id],
			homeX: home.x,
			homeY: home.y,
			radius: home.radius,
		}
	})
}

/**
 * Advance one frame. `time` is seconds since motion started. `amplitude`
 * is 1 on a wide screen, smaller on a phone, and 0 when the caller wants
 * the orbs held at their homes. Does not mutate `bodies`.
 */
export function stepLanternOrbMotion(
	bodies: ReadonlyArray<LanternOrbBody>,
	dtSeconds: number,
	options: { time: number; amplitude: number },
): Array<LanternOrbBody> {
	const dt = Math.min(Math.max(dtSeconds, 0), 1 / 30)
	const amplitude = Math.min(Math.max(options.amplitude, 0), 1)
	const next = bodies.map((body) => ({ ...body }))
	for (const body of next) {
		const target = wanderTarget(body, options.time, amplitude)
		const ax = (target.x - body.x) * spring
		const ay = (target.y - body.y) * spring
		body.vx = (body.vx + ax * dt) * Math.exp(-damping * dt)
		body.vy = (body.vy + ay * dt) * Math.exp(-damping * dt)
		const speed = Math.hypot(body.vx, body.vy)
		if (speed > maxSpeed) {
			body.vx *= maxSpeed / speed
			body.vy *= maxSpeed / speed
		}
		body.x += body.vx * dt
		body.y += body.vy * dt
	}
	for (let pass = 0; pass < 4; pass++) {
		separateOrbs(next)
		containOrbs(next)
	}
	return next
}

function wanderTarget(body: LanternOrbBody, time: number, amplitude: number) {
	const reach = roam * amplitude
	const angle = time * wanderRate + body.phase
	const swirl = time * swirlRate
	const x =
		body.homeX +
		Math.cos(angle) * reach +
		Math.cos(swirl + body.phase) * 0.026 * amplitude
	const y =
		body.homeY +
		Math.sin(angle * 0.76 + 0.7) * reach * 0.9 +
		Math.sin(swirl) * 0.02 * amplitude
	return clampToCavity(x, y, body.radius)
}

/** Keep a centre inside the glass, inset by the orb's own radius. */
export function clampToCavity(x: number, y: number, radius: number) {
	const dx = x - landingLanternCavity.x
	const dy = y - landingLanternCavity.y
	const distance = Math.hypot(dx, dy)
	const limit = landingLanternCavity.r - radius - wallSkin
	if (distance <= limit || distance === 0) return { x, y }
	const scale = limit / distance
	return {
		x: landingLanternCavity.x + dx * scale,
		y: landingLanternCavity.y + dy * scale,
	}
}

function separateOrbs(bodies: Array<LanternOrbBody>) {
	for (let i = 0; i < bodies.length; i++) {
		const a = bodies[i]!
		for (let j = i + 1; j < bodies.length; j++) {
			const b = bodies[j]!
			const dx = b.x - a.x
			const dy = b.y - a.y
			const distance = Math.hypot(dx, dy)
			const min = a.radius + b.radius
			if (distance >= min) continue
			// Coincident centres: nudge on x so the next pass has a normal.
			const nx = distance === 0 ? 1 : dx / distance
			const ny = distance === 0 ? 0 : dy / distance
			const overlap = min - distance
			const push = overlap * 0.45
			a.x -= nx * push
			a.y -= ny * push
			b.x += nx * push
			b.y += ny * push
			const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny
			if (closing > 0) {
				// Split the closing speed so the pair stops, instead of bouncing.
				a.vx -= closing * nx * 0.5
				a.vy -= closing * ny * 0.5
				b.vx += closing * nx * 0.5
				b.vy += closing * ny * 0.5
			}
		}
	}
}

function containOrbs(bodies: Array<LanternOrbBody>) {
	for (const body of bodies) {
		const dx = body.x - landingLanternCavity.x
		const dy = body.y - landingLanternCavity.y
		const distance = Math.hypot(dx, dy)
		const limit = landingLanternCavity.r - body.radius - wallSkin
		if (distance <= limit || distance === 0) continue
		const nx = dx / distance
		const ny = dy / distance
		body.x = landingLanternCavity.x + nx * limit
		body.y = landingLanternCavity.y + ny * limit
		// Cancel the outward speed so the orb slides along the glass
		// instead of springing back across the globe.
		const outward = body.vx * nx + body.vy * ny
		if (outward > 0) {
			body.vx -= outward * nx
			body.vy -= outward * ny
		}
	}
}
