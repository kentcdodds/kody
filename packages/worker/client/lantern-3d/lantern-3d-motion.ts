import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'
import { lanternCavity, lanternOrbRadius } from './lantern-3d-layout.ts'

/**
 * Motion inside the 3D lantern, in world units (see lantern-3d-layout.ts).
 *
 * The orbs are the 2D lava lamp in three dimensions: each eases toward a
 * slow wander around its rest, syrup damps it, and contact only cancels
 * the closing speed. The globe also holds a fluid that the lantern's spin
 * drags along. Spin the lantern and the fluid catches up, carries the orbs
 * and sparkles round, then lets the orbs drift home once it slows. A held
 * orb follows the pointer, and a flick coasts and bounces like the 2D toss.
 *
 * The lantern turns with inertia, settles face-on, tips back upright, and
 * its handle swings on a loose spring.
 */

export type Vec3 = { x: number; y: number; z: number }

type LanternOrb3d = Vec3 & {
	id: LandingPrimitiveId
	vx: number
	vy: number
	vz: number
	home: Vec3
	phase: number
	radius: number
	/** A toss, a knock, or the fluid is carrying this orb. */
	coasting: boolean
}

export type LanternOrbHold3d = Vec3 & {
	id: LandingPrimitiveId
	vx: number
	vy: number
	vz: number
}

export type LanternContents = {
	orbs: Array<LanternOrb3d>
	/** Fluid angular velocity about the lantern axis, radians per second. */
	swirl: number
	/** Fluid angle, radians. The sparkles ride it. */
	swirlAngle: number
}

export type LanternContentsStep = {
	/** Seconds since motion started. */
	time: number
	/** 1 for the full wander, 0 to hold every orb at rest. */
	amplitude: number
	/** Lantern spin, radians per second. */
	spin: number
	/** Lantern tilt about x, radians. Tips the cap and base with it. */
	tilt: number
	hold?: LanternOrbHold3d | null
	/** Draws one orb to a point: the open primitive comes forward. */
	lure?: (Vec3 & { id: LandingPrimitiveId }) | null
}

export type LanternPointerSample3d = Vec3 & {
	/** Milliseconds, same clock as the other samples in the gesture. */
	t: number
}

/** How far a wander target sits from the orb's rest, across and up. */
const roam = 0.2

/** How far the wander reaches toward and away from the camera. */
const depthRoam = 0.24

/** Wander angular speed, radians per second. */
const wanderRate = 0.34

/** Shared swirl so the cluster drifts into its neighbours. */
const swirlRate = 0.1

/** Pull toward the wander target, per second squared. */
const spring = 1.15

/** Velocity decay, per second. High so a bump stops instead of shooting off. */
const damping = 2.6

/** Float speed cap near the target. */
const floatSpeed = 0.1

/** Extra float speed per unit of distance to the target, so an orb the
 *  fluid carried round comes home in a couple of seconds. */
const homeward = 0.9

/** The open orb's approach: quick and critically damped. */
const lureSpring = 16
const lureDamping = 8

/** A flick can cross the globe in a few frames, never in one. */
const coastMaxSpeed = 4.8

/** Velocity decay while a toss is in flight, per second. */
const coastDamping = 1.05

/** Below this a toss is over and the wander resumes. */
const coastSettleSpeed = 0.1

/** Speed kept when a toss hits the glass or another orb. */
const restitution = 0.62

/** How far back a flick's velocity sample looks, in milliseconds. */
const flickWindowMs = 90

/** Gap between an orb's rim and the glass. */
const wallSkin = 0.017

/** How fast the fluid catches the lantern's spin, per second. */
const fluidCoupling = 1.6

/** How hard the fluid drags a carried orb, per second. */
const fluidDrag = 2.4

/** Fluid speed that lifts the orbs off their wander, radians per second. */
const fluidCarry = 0.55

const phases: Record<LandingPrimitiveId, number> = {
	memory: 0.5,
	secrets: 2.05,
	packages: 3.7,
	triggers: 5.15,
	integrations: 1.15,
	apps: 6.4,
}

export function createLanternContents(
	rests: ReadonlyArray<Vec3 & { id: LandingPrimitiveId }>,
): LanternContents {
	return {
		orbs: rests.map((rest) => {
			const home = clampToCavity(rest, lanternOrbRadius, 0)
			return {
				id: rest.id,
				...home,
				vx: 0,
				vy: 0,
				vz: 0,
				home,
				phase: phases[rest.id],
				radius: lanternOrbRadius,
				coasting: false,
			}
		}),
		swirl: 0,
		swirlAngle: 0,
	}
}

/** Advance one frame. Does not mutate `contents`. */
export function stepLanternContents(
	contents: LanternContents,
	dtSeconds: number,
	options: LanternContentsStep,
): LanternContents {
	const dt = Math.min(Math.max(dtSeconds, 0), 1 / 30)
	const amplitude = Math.min(Math.max(options.amplitude, 0), 1)
	const hold = options.hold ?? null
	const lure = options.lure ?? null
	const heldId = hold?.id ?? null
	const swirl =
		options.spin +
		(contents.swirl - options.spin) * Math.exp(-fluidCoupling * dt)
	const carried = Math.abs(swirl) > fluidCarry
	const orbs = contents.orbs.map((orb) => ({ ...orb }))
	for (const orb of orbs) {
		if (hold && orb.id === hold.id) {
			placeHeld(orb, hold, options.tilt)
			continue
		}
		if (carried) orb.coasting = true
		if (orb.coasting) {
			integrateCoast(orb, dt, swirl)
			continue
		}
		if (lure && orb.id === lure.id) {
			const target = clampToCavity(lure, orb.radius, options.tilt)
			approach(orb, target, dt, lureSpring, lureDamping, coastMaxSpeed)
			continue
		}
		const target = wanderTarget(orb, options.time, amplitude, options.tilt)
		const cap = floatSpeed + distance(orb, target) * homeward
		approach(orb, target, dt, spring, damping, cap)
	}
	for (let pass = 0; pass < 4; pass++) {
		separateOrbs(orbs, heldId)
		containOrbs(orbs, heldId, options.tilt)
		if (hold) {
			const held = orbs.find((orb) => orb.id === hold.id)
			if (held) placeHeld(held, hold, options.tilt)
		}
	}
	// The last snap can sit the held orb back on a neighbour. Shove that
	// neighbour out without giving the pointer up.
	separateOrbs(orbs, heldId)
	containOrbs(orbs, heldId, options.tilt)
	for (const orb of orbs) {
		if (orb.id === heldId || !orb.coasting || carried) continue
		if (speedOf(orb) >= coastSettleSpeed) continue
		orb.coasting = false
	}
	return { orbs, swirl, swirlAngle: contents.swirlAngle + swirl * dt }
}

/**
 * Velocity from the recent end of a drag, per second, in whatever space
 * the samples are in. A short or stale gesture releases with no flick.
 */
export function lanternFlickVelocity(
	samples: ReadonlyArray<LanternPointerSample3d>,
	now: number,
	limit = coastMaxSpeed,
) {
	let first: LanternPointerSample3d | null = null
	let last: LanternPointerSample3d | null = null
	for (const sample of samples) {
		if (now - sample.t > flickWindowMs) continue
		if (!first) first = sample
		last = sample
	}
	const still = { vx: 0, vy: 0, vz: 0 }
	if (!first || !last || first === last) return still
	const dt = (last.t - first.t) / 1000
	if (dt <= 0.012) return still
	const velocity = {
		vx: (last.x - first.x) / dt,
		vy: (last.y - first.y) / dt,
		vz: (last.z - first.z) / dt,
	}
	const speed = Math.hypot(velocity.vx, velocity.vy, velocity.vz)
	if (speed <= limit) return velocity
	const scale = limit / speed
	return {
		vx: velocity.vx * scale,
		vy: velocity.vy * scale,
		vz: velocity.vz * scale,
	}
}

/** Keep a centre inside the glass and clear of the cap and base. */
export function clampToCavity(point: Vec3, radius: number, tilt: number) {
	const limit = lanternCavity.radius - radius - wallSkin
	let { x, y, z } = point
	const reach = Math.hypot(x, y, z)
	if (reach > limit && reach !== 0) {
		const scale = limit / reach
		x *= scale
		y *= scale
		z *= scale
	}
	const up = lanternUp(tilt)
	const band = bandFor(radius)
	const height = y * up.y + z * up.z
	const over =
		height > band.top
			? height - band.top
			: height < band.bottom
				? height - band.bottom
				: 0
	return { x, y: y - over * up.y, z: z - over * up.z }
}

function integrateCoast(orb: LanternOrb3d, dt: number, swirl: number) {
	const decay = Math.exp(-coastDamping * dt)
	orb.vx *= decay
	orb.vy *= decay
	orb.vz *= decay
	if (swirl !== 0) {
		// The fluid turns about y, so it moves at swirl × (z, 0, -x).
		const drag = 1 - Math.exp(-fluidDrag * dt)
		orb.vx += (swirl * orb.z - orb.vx) * drag
		orb.vz += (-swirl * orb.x - orb.vz) * drag
	}
	capSpeed(orb, coastMaxSpeed)
	orb.x += orb.vx * dt
	orb.y += orb.vy * dt
	orb.z += orb.vz * dt
}

function approach(
	orb: LanternOrb3d,
	target: Vec3,
	dt: number,
	pull: number,
	syrup: number,
	cap: number,
) {
	const decay = Math.exp(-syrup * dt)
	orb.vx = (orb.vx + (target.x - orb.x) * pull * dt) * decay
	orb.vy = (orb.vy + (target.y - orb.y) * pull * dt) * decay
	orb.vz = (orb.vz + (target.z - orb.z) * pull * dt) * decay
	capSpeed(orb, cap)
	orb.x += orb.vx * dt
	orb.y += orb.vy * dt
	orb.z += orb.vz * dt
}

function wanderTarget(
	orb: LanternOrb3d,
	time: number,
	amplitude: number,
	tilt: number,
) {
	const reach = roam * amplitude
	const angle = time * wanderRate + orb.phase
	const swirl = time * swirlRate
	return clampToCavity(
		{
			x:
				orb.home.x +
				Math.cos(angle) * reach +
				Math.cos(swirl + orb.phase) * 0.056 * amplitude,
			y:
				orb.home.y +
				Math.sin(angle * 0.76 + 0.7) * reach * 0.9 +
				Math.sin(swirl) * 0.043 * amplitude,
			z:
				orb.home.z +
				Math.sin(angle * 0.58 + orb.phase * 1.7) * depthRoam * amplitude,
		},
		orb.radius,
		tilt,
	)
}

function placeHeld(orb: LanternOrb3d, hold: LanternOrbHold3d, tilt: number) {
	const clamped = clampToCavity(hold, orb.radius, tilt)
	orb.x = clamped.x
	orb.y = clamped.y
	orb.z = clamped.z
	orb.vx = hold.vx
	orb.vy = hold.vy
	orb.vz = hold.vz
	capSpeed(orb, coastMaxSpeed)
	orb.coasting = true
}

/** The lantern's own up axis in world space after the tilt about x. */
function lanternUp(tilt: number) {
	return { y: Math.cos(tilt), z: Math.sin(tilt) }
}

/** Centre heights an orb may reach between the cap and the base. */
function bandFor(radius: number) {
	return {
		top: lanternCavity.top - radius - wallSkin,
		bottom: lanternCavity.bottom + radius + wallSkin,
	}
}

function separateOrbs(orbs: Array<LanternOrb3d>, heldId: string | null) {
	for (let i = 0; i < orbs.length; i++) {
		const a = orbs[i]!
		for (let j = i + 1; j < orbs.length; j++) {
			const b = orbs[j]!
			const dx = b.x - a.x
			const dy = b.y - a.y
			const dz = b.z - a.z
			const gap = Math.hypot(dx, dy, dz)
			const min = a.radius + b.radius
			if (gap >= min) continue
			// Coincident centres: nudge on x so the next pass has a normal.
			const nx = gap === 0 ? 1 : dx / gap
			const ny = gap === 0 ? 0 : dy / gap
			const nz = gap === 0 ? 0 : dz / gap
			const overlap = min - gap
			const aHeld = a.id === heldId
			const bHeld = b.id === heldId
			if (!a.coasting && !b.coasting && !aHeld && !bHeld) {
				const push = overlap * 0.45
				move(a, nx, ny, nz, -push)
				move(b, nx, ny, nz, push)
				const closing =
					(a.vx - b.vx) * nx + (a.vy - b.vy) * ny + (a.vz - b.vz) * nz
				if (closing > 0) {
					// Split the closing speed so the pair stops instead of bouncing.
					nudge(a, nx, ny, nz, -closing * 0.5)
					nudge(b, nx, ny, nz, closing * 0.5)
				}
				continue
			}
			if (aHeld && !bHeld) {
				move(b, nx, ny, nz, overlap)
				shove(b, a, nx, ny, nz)
				continue
			}
			if (bHeld && !aHeld) {
				move(a, nx, ny, nz, -overlap)
				shove(a, b, -nx, -ny, -nz)
				continue
			}
			move(a, nx, ny, nz, -overlap * 0.5)
			move(b, nx, ny, nz, overlap * 0.5)
			const approachSpeed =
				(a.vx - b.vx) * nx + (a.vy - b.vy) * ny + (a.vz - b.vz) * nz
			if (approachSpeed <= 0) continue
			const impulse = (1 + restitution) * 0.5 * approachSpeed
			nudge(a, nx, ny, nz, -impulse)
			nudge(b, nx, ny, nz, impulse)
			capSpeed(a, coastMaxSpeed)
			capSpeed(b, coastMaxSpeed)
			kick(a)
			kick(b)
		}
	}
}

/** Push `orb` as if it hit `wall`, an immovable disc moving with the pointer. */
function shove(
	orb: LanternOrb3d,
	wall: LanternOrb3d,
	nx: number,
	ny: number,
	nz: number,
) {
	const approachSpeed =
		(wall.vx - orb.vx) * nx + (wall.vy - orb.vy) * ny + (wall.vz - orb.vz) * nz
	if (approachSpeed <= 0) return
	nudge(orb, nx, ny, nz, (1 + restitution) * approachSpeed)
	capSpeed(orb, coastMaxSpeed)
	kick(orb)
}

function containOrbs(
	orbs: Array<LanternOrb3d>,
	heldId: string | null,
	tilt: number,
) {
	const up = lanternUp(tilt)
	for (const orb of orbs) {
		if (orb.id === heldId) continue
		const limit = lanternCavity.radius - orb.radius - wallSkin
		const reach = Math.hypot(orb.x, orb.y, orb.z)
		if (reach > limit && reach !== 0) {
			const nx = orb.x / reach
			const ny = orb.y / reach
			const nz = orb.z / reach
			orb.x = nx * limit
			orb.y = ny * limit
			orb.z = nz * limit
			bounce(orb, nx, ny, nz)
		}
		const band = bandFor(orb.radius)
		const height = orb.y * up.y + orb.z * up.z
		if (height > band.top) {
			move(orb, 0, up.y, up.z, band.top - height)
			bounce(orb, 0, up.y, up.z)
		} else if (height < band.bottom) {
			move(orb, 0, up.y, up.z, band.bottom - height)
			bounce(orb, 0, -up.y, -up.z)
		}
	}
}

/**
 * Speed out through a wall with outward normal `n`: a toss reflects back
 * into the globe, a floating orb slides along the glass instead.
 */
function bounce(orb: LanternOrb3d, nx: number, ny: number, nz: number) {
	const outward = orb.vx * nx + orb.vy * ny + orb.vz * nz
	if (outward <= 0) return
	const factor = orb.coasting ? 1 + restitution : 1
	nudge(orb, nx, ny, nz, -factor * outward)
	capSpeed(orb, coastMaxSpeed)
}

function move(
	orb: LanternOrb3d,
	nx: number,
	ny: number,
	nz: number,
	amount: number,
) {
	orb.x += nx * amount
	orb.y += ny * amount
	orb.z += nz * amount
}

function nudge(
	orb: LanternOrb3d,
	nx: number,
	ny: number,
	nz: number,
	amount: number,
) {
	orb.vx += nx * amount
	orb.vy += ny * amount
	orb.vz += nz * amount
}

function kick(orb: LanternOrb3d) {
	if (speedOf(orb) <= coastSettleSpeed) return
	orb.coasting = true
}

function speedOf(orb: LanternOrb3d) {
	return Math.hypot(orb.vx, orb.vy, orb.vz)
}

function distance(a: Vec3, b: Vec3) {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function capSpeed(orb: LanternOrb3d, limit: number) {
	const speed = speedOf(orb)
	if (speed <= limit || speed === 0) return
	const scale = limit / speed
	orb.vx *= scale
	orb.vy *= scale
	orb.vz *= scale
}

export type LanternSpin = {
	yaw: number
	yawVelocity: number
	tilt: number
	tiltVelocity: number
	/** Handle swing about its hinge, radians. */
	swing: number
	swingVelocity: number
}

/** Tilt range, radians. Positive tips the cap toward the camera. */
export const lanternTiltLimit = { min: -0.3, max: 0.42 } as const

/** Fastest spin a flick can start, radians per second. */
export const lanternMaxSpin = 14

/** Spin decay per second once the pointer lets go. */
const spinDamping = 1.25

/** Below this spin the lantern eases face-on, so the handle ends square. */
const settleSpin = 1.1
const settleSpring = 5
const settleDamping = 3.6

const tiltSpring = 28
const tiltDamping = 9.5

/** Loose on purpose: the handle wobbles after a toss. */
const swingSpring = 30
const swingDamping = 3.2
const swingLimit = 0.55

export function createLanternSpin(): LanternSpin {
	return {
		yaw: 0,
		yawVelocity: 0,
		tilt: 0,
		tiltVelocity: 0,
		swing: 0,
		swingVelocity: 0,
	}
}

/**
 * A pointer turn, in radians. Yaw applies as given; tilt stiffens toward
 * its limit. The velocities are smoothed so the handle reacts to the
 * gesture rather than one jittery event.
 */
export function dragLanternSpin(
	spin: LanternSpin,
	turn: { yaw: number; tilt: number },
	dtSeconds: number,
): LanternSpin {
	const tilt = resistTilt(spin.tilt, turn.tilt)
	const dt = Math.max(dtSeconds, 1 / 240)
	return {
		...spin,
		yaw: spin.yaw + turn.yaw,
		tilt,
		yawVelocity: spin.yawVelocity * 0.6 + (turn.yaw / dt) * 0.4,
		tiltVelocity: spin.tiltVelocity * 0.6 + ((tilt - spin.tilt) / dt) * 0.4,
	}
}

/**
 * Advance one frame. A held lantern only moves its handle; a free one
 * coasts, eases face-on when `settle` is set, and tips back upright.
 */
export function stepLanternSpin(
	spin: LanternSpin,
	dtSeconds: number,
	options: { held: boolean; settle: boolean },
): LanternSpin {
	const dt = Math.min(Math.max(dtSeconds, 0), 1 / 30)
	const next = { ...spin }
	if (!options.held) {
		if (options.settle && Math.abs(next.yawVelocity) < settleSpin) {
			const target = Math.round(next.yaw / Math.PI) * Math.PI
			next.yawVelocity +=
				((target - next.yaw) * settleSpring -
					next.yawVelocity * settleDamping) *
				dt
		} else {
			next.yawVelocity *= Math.exp(-spinDamping * dt)
		}
		next.yaw += next.yawVelocity * dt
		next.tiltVelocity +=
			(-next.tilt * tiltSpring - next.tiltVelocity * tiltDamping) * dt
		next.tilt += next.tiltVelocity * dt
	}
	// The handle lags a tilt and leans out when the lantern spins fast.
	const swingTarget = Math.min(
		Math.max(
			-next.tiltVelocity * 0.09 + Math.abs(next.yawVelocity) * 0.014,
			-swingLimit,
		),
		swingLimit,
	)
	next.swingVelocity +=
		((swingTarget - next.swing) * swingSpring -
			next.swingVelocity * swingDamping) *
		dt
	next.swing = Math.min(
		Math.max(next.swing + next.swingVelocity * dt, -swingLimit),
		swingLimit,
	)
	return next
}

/** Drag away from upright gets through less the nearer the limit it is. */
function resistTilt(tilt: number, delta: number) {
	const { min, max } = lanternTiltLimit
	const limit = delta > 0 ? max : min
	const share = delta * tilt > 0 ? Math.max(0, 1 - (tilt / limit) ** 2) : 1
	return Math.min(Math.max(tilt + delta * share, min), max)
}
