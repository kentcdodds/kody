/**
 * Motion for the six homepage lantern orbs.
 *
 * Coordinates are fractions of the lantern width, including y, so a circle
 * in this space is a circle in pixels (the still is taller than it is wide).
 * Idle motion is a lava lamp: each orb eases toward a slow wander target,
 * syrup damps the velocity, and contact with another orb or the inner glass
 * only cancels the closing speed. A grab is different. While a pointer holds
 * an orb it follows that point, and a flick keeps the release velocity:
 * the toss coasts, bounces off the glass, and knocks into the other orbs,
 * then the lava lamp takes over again once the toss has slowed.
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

/**
 * The lid and the base bite into that circle. Fractions of lantern height,
 * measured from the neutral metal in the shell: bottom of the cap, top of
 * the base. A disc centre may not cross them.
 */
export const landingLanternAperture = {
	top: 0.304,
	bottom: 0.845,
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

/**
 * A flick can cross the globe. Capped so one frame cannot tunnel through
 * another disc (the step itself also refuses a dt above 1/30).
 */
const coastMaxSpeed = 2.2

/** Velocity decay while a toss is in flight, per second. */
const coastDamping = 1.05

/** Below this a toss is over and the lava-lamp wander resumes. */
const coastSettleSpeed = 0.045

/** Speed kept when a toss hits the glass or another orb. */
const restitution = 0.62

/** How far back a flick's velocity sample looks, in milliseconds. */
const flickWindowMs = 90

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
	/** A grab or a knock is still carrying this orb. */
	coasting: boolean
}

/** Pointer hold, in the same width-fraction space as the bodies. */
export type LanternOrbHold = {
	id: LandingPrimitiveId
	x: number
	y: number
	vx: number
	vy: number
}

export type LanternPointerSample = {
	x: number
	y: number
	/** Milliseconds, same clock as the other samples in the gesture. */
	t: number
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
			coasting: false,
		}
	})
}

/**
 * Orb-centre velocity from the recent end of a drag, in width-fractions
 * per second. A short or stale gesture releases with no flick.
 */
export function lanternFlickVelocity(
	samples: ReadonlyArray<LanternPointerSample>,
	now: number,
) {
	let first: LanternPointerSample | null = null
	let last: LanternPointerSample | null = null
	for (const sample of samples) {
		if (now - sample.t > flickWindowMs) continue
		if (!first) first = sample
		last = sample
	}
	if (!first || !last || first === last) return { vx: 0, vy: 0 }
	const dt = (last.t - first.t) / 1000
	if (dt <= 0.012) return { vx: 0, vy: 0 }
	return capVelocity(
		(last.x - first.x) / dt,
		(last.y - first.y) / dt,
		coastMaxSpeed,
	)
}

/**
 * Advance one frame. `time` is seconds since motion started. `amplitude`
 * is 1 on a wide screen, smaller on a phone, and 0 when the caller wants
 * the orbs held at their homes. `hold` pins one orb to a pointer. Does not
 * mutate `bodies`.
 */
export function stepLanternOrbMotion(
	bodies: ReadonlyArray<LanternOrbBody>,
	dtSeconds: number,
	options: { time: number; amplitude: number; hold?: LanternOrbHold | null },
): Array<LanternOrbBody> {
	const dt = Math.min(Math.max(dtSeconds, 0), 1 / 30)
	const amplitude = Math.min(Math.max(options.amplitude, 0), 1)
	const hold = options.hold ?? null
	const next = bodies.map((body) => ({ ...body }))
	for (const body of next) {
		if (hold && body.id === hold.id) {
			placeHeld(body, hold)
			continue
		}
		if (body.coasting) {
			integrateCoast(body, dt)
			continue
		}
		integrateFloat(body, dt, options.time, amplitude)
	}
	for (let pass = 0; pass < 4; pass++) {
		separateOrbs(next, hold?.id ?? null)
		containOrbs(next, hold?.id ?? null)
		if (hold) {
			const held = next.find((body) => body.id === hold.id)
			if (held) placeHeld(held, hold)
		}
	}
	// The last snap can sit the held disc back on a neighbour. Shove
	// that neighbour out without giving the pointer up.
	separateOrbs(next, hold?.id ?? null)
	containOrbs(next, hold?.id ?? null)
	for (const body of next) {
		if (hold && body.id === hold.id) continue
		if (!body.coasting) continue
		if (Math.hypot(body.vx, body.vy) >= coastSettleSpeed) continue
		body.coasting = false
	}
	return next
}

function integrateFloat(
	body: LanternOrbBody,
	dt: number,
	time: number,
	amplitude: number,
) {
	const target = wanderTarget(body, time, amplitude)
	const ax = (target.x - body.x) * spring
	const ay = (target.y - body.y) * spring
	body.vx = (body.vx + ax * dt) * Math.exp(-damping * dt)
	body.vy = (body.vy + ay * dt) * Math.exp(-damping * dt)
	capSpeed(body, maxSpeed)
	body.x += body.vx * dt
	body.y += body.vy * dt
}

/** Inertia only. The wander spring stays off until the toss has slowed. */
function integrateCoast(body: LanternOrbBody, dt: number) {
	body.vx *= Math.exp(-coastDamping * dt)
	body.vy *= Math.exp(-coastDamping * dt)
	capSpeed(body, coastMaxSpeed)
	body.x += body.vx * dt
	body.y += body.vy * dt
}

function placeHeld(body: LanternOrbBody, hold: LanternOrbHold) {
	const clamped = clampToCavity(hold.x, hold.y, body.radius)
	body.x = clamped.x
	body.y = clamped.y
	body.vx = hold.vx
	body.vy = hold.vy
	capSpeed(body, coastMaxSpeed)
	body.coasting = true
}

function capSpeed(body: LanternOrbBody, limit: number) {
	const speed = Math.hypot(body.vx, body.vy)
	if (speed <= limit || speed === 0) return
	body.vx *= limit / speed
	body.vy *= limit / speed
}

function capVelocity(vx: number, vy: number, limit: number) {
	const speed = Math.hypot(vx, vy)
	if (speed <= limit || speed === 0) return { vx, vy }
	const scale = limit / speed
	return { vx: vx * scale, vy: vy * scale }
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

/** Keep a centre inside the glass and clear of the lid and base. */
export function clampToCavity(x: number, y: number, radius: number) {
	const dx = x - landingLanternCavity.x
	const dy = y - landingLanternCavity.y
	const distance = Math.hypot(dx, dy)
	const limit = landingLanternCavity.r - radius - wallSkin
	let nextX = x
	let nextY = y
	if (distance > limit && distance !== 0) {
		const scale = limit / distance
		nextX = landingLanternCavity.x + dx * scale
		nextY = landingLanternCavity.y + dy * scale
	}
	const band = apertureWindow(radius)
	if (nextY < band.top) nextY = band.top
	if (nextY > band.bottom) nextY = band.bottom
	return { x: nextX, y: nextY }
}

/** Disc-centre limits, in the motion's width-fraction space. */
function apertureWindow(radius: number) {
	return {
		top: landingLanternAperture.top * landingLanternAspect + radius + wallSkin,
		bottom:
			landingLanternAperture.bottom * landingLanternAspect - radius - wallSkin,
	}
}

function separateOrbs(
	bodies: Array<LanternOrbBody>,
	heldId: LandingPrimitiveId | null,
) {
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
			const aHeld = heldId !== null && a.id === heldId
			const bHeld = heldId !== null && b.id === heldId
			if (!a.coasting && !b.coasting && !aHeld && !bHeld) {
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
				continue
			}
			resolveTossContact(a, b, nx, ny, overlap, aHeld, bHeld)
		}
	}
}

/**
 * A held orb is a moving wall: it keeps the pointer and shoves the other
 * disc. Two free tosses share an equal-mass bounce.
 */
function resolveTossContact(
	a: LanternOrbBody,
	b: LanternOrbBody,
	nx: number,
	ny: number,
	overlap: number,
	aHeld: boolean,
	bHeld: boolean,
) {
	if (aHeld && !bHeld) {
		b.x += nx * overlap
		b.y += ny * overlap
		shove(b, a.vx, a.vy, nx, ny, 1 + restitution)
		return
	}
	if (bHeld && !aHeld) {
		a.x -= nx * overlap
		a.y -= ny * overlap
		shove(a, b.vx, b.vy, -nx, -ny, 1 + restitution)
		return
	}
	const push = overlap * 0.5
	a.x -= nx * push
	a.y -= ny * push
	b.x += nx * push
	b.y += ny * push
	const approach = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny
	if (approach <= 0) return
	const impulse = (1 + restitution) * 0.5 * approach
	a.vx -= impulse * nx
	a.vy -= impulse * ny
	b.vx += impulse * nx
	b.vy += impulse * ny
	capSpeed(a, coastMaxSpeed)
	capSpeed(b, coastMaxSpeed)
	kick(a)
	kick(b)
}

/** Push `body` as if it hit an immovable disc moving at `(vx, vy)`. */
function shove(
	body: LanternOrbBody,
	vx: number,
	vy: number,
	nx: number,
	ny: number,
	factor: number,
) {
	const approach = (vx - body.vx) * nx + (vy - body.vy) * ny
	if (approach <= 0) return
	body.vx += factor * approach * nx
	body.vy += factor * approach * ny
	capSpeed(body, coastMaxSpeed)
	kick(body)
}

function kick(body: LanternOrbBody) {
	if (Math.hypot(body.vx, body.vy) <= coastSettleSpeed) return
	body.coasting = true
}

function containOrbs(
	bodies: Array<LanternOrbBody>,
	heldId: LandingPrimitiveId | null,
) {
	for (const body of bodies) {
		if (heldId !== null && body.id === heldId) continue
		const dx = body.x - landingLanternCavity.x
		const dy = body.y - landingLanternCavity.y
		const distance = Math.hypot(dx, dy)
		const limit = landingLanternCavity.r - body.radius - wallSkin
		if (distance <= limit || distance === 0) continue
		const nx = dx / distance
		const ny = dy / distance
		body.x = landingLanternCavity.x + nx * limit
		body.y = landingLanternCavity.y + ny * limit
		const outward = body.vx * nx + body.vy * ny
		if (outward <= 0) continue
		if (body.coasting) {
			// Reflect off the inner glass so a toss comes back into the globe.
			body.vx -= (1 + restitution) * outward * nx
			body.vy -= (1 + restitution) * outward * ny
			capSpeed(body, coastMaxSpeed)
		} else {
			// Cancel the outward speed so the orb slides along the glass
			// instead of springing back across the globe.
			body.vx -= outward * nx
			body.vy -= outward * ny
		}
	}
	for (const body of bodies) {
		if (heldId !== null && body.id === heldId) continue
		const band = apertureWindow(body.radius)
		if (body.y < band.top) {
			body.y = band.top
			if (body.vy < 0) body.vy = body.coasting ? -body.vy * restitution : 0
		} else if (body.y > band.bottom) {
			body.y = band.bottom
			if (body.vy > 0) body.vy = body.coasting ? -body.vy * restitution : 0
		}
	}
}
