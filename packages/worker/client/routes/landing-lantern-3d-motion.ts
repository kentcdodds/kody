import {
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * Motion for the 3D lantern (landing-lantern-3d.gss). Pure math, no DOM:
 * the camera projection that keeps the HTML orb buttons on the painted
 * orbs, the turntable orbit, the orbs floating inside the globe, Kody's
 * idle moment, and the frame-rate checks behind the warm-up and the
 * adaptive resolution.
 *
 * Orbs live in the lantern's own frame (`local`), so they turn with it.
 * `localToWorld` applies the same turn the scene gives the bail
 * (`rotate-y: --yaw`), so an orb set from it turns exactly as the bail
 * does. Idle orbs drift like a lava lamp toward slow wander targets. A
 * grabbed orb follows the pointer and a flick tosses it: it coasts,
 * bounces off the glass, Kody, and the other orbs, then settles back into
 * the drift. Spinning the lantern lets the orbs lag behind and fling
 * outward, like marbles in a turning jar.
 *
 * The homes step down the globe in the order of the word list, so from
 * every side the orbs keep that order down the screen and the leader lines
 * to the words never cross. The lantern only turns about its axis: a tilt
 * would shuffle that order.
 */

export type Vec3 = { x: number; y: number; z: number }

const degrees = Math.PI / 180

/** The scene camera in landing-lantern-3d.gss. GSS shoots each ray along
 *  `uv.x * right + uv.y * up + zoom * forward`, uv in canvas heights. */
const lanternCamera = {
	yaw: 0,
	pitch: 10 * degrees,
	distance: 5.5,
	target: { x: 0, y: 0.18, z: 0 },
	zoom: 1.5,
} as const

/** Glass globe, centered on the pivot. Matches the glow and rim in the scene. */
export const lanternGlobeRadius = 0.97

/** Orb radius before hover scaling (`.ball` in the scene). */
export const lanternOrbRadius = 0.175

/** Room the orbs swim in: inside the glass, between the cap and the base. */
const cavity = { radius: 0.86, top: 0.66, bottom: -0.64 } as const

/** Kody and his flame (`#kody` and `#flame` in the scene): a capsule up the
 *  lantern's axis. He never turns, but on the axis the same capsule holds
 *  in the lantern's frame at every turn. */
const kody = { bottom: -0.26, top: 0.32, radius: 0.2 } as const

/** Kody's head, which his gaze turns about. */
const kodyHead = { x: 0, y: -0.14, z: 0.04 } as const

/** Top to bottom in the order of the word list, in a ring round Kody. The
 *  orbs to the left of him sit over his flame or under his chin, so the
 *  leaders from them pass him by, and through the sway no orb hides his
 *  face or another orb's glyph, and none sits behind the flame. Matches
 *  the initial orb positions in landing-lantern-3d.gss. */
const lanternOrbHomes: Record<LandingPrimitiveId, Vec3> = {
	memory: { x: -0.38, y: 0.475, z: -0.011 },
	secrets: { x: 0.322, y: 0.355, z: -0.39 },
	packages: { x: 0.487, y: 0.124, z: -0.052 },
	triggers: { x: 0.397, y: -0.089, z: 0.317 },
	integrations: { x: -0.272, y: -0.301, z: 0.28 },
	apps: { x: 0.124, y: -0.439, z: 0.464 },
}

const phases: Record<LandingPrimitiveId, number> = {
	memory: 0.5,
	secrets: 2.05,
	packages: 3.7,
	triggers: 5.15,
	integrations: 1.15,
	apps: 6.4,
}

/** How far a wander target sits from home. Past this, the drift can swap
 *  two orbs' order on screen while the lantern is turned side on. */
const roam = 0.055
/** Share of `roam` the drift takes up and down, where the orbs' order is. */
const roamRise = 0.35
/** Wander angular speed, radians per second. */
const wanderRate = 0.34
/** Pull toward the wander target, per second. */
const spring = 1.15
/** Velocity decay, per second, while floating. */
const damping = 2.6
/** Speed ceiling while floating. */
const floatMaxSpeed = 0.09
/** A flick can cross the globe in a fraction of a second. */
const coastMaxSpeed = 4.2
const coastDamping = 1.05
const coastSettleSpeed = 0.09
const restitution = 0.62
const wallSkin = 0.01
/** Share of the lantern's turn the orbs do not follow at once. */
const spinSlip = 0.35
/** Outward push per (radian per second) squared of spin. */
const spinFling = 0.05
/** How far back a flick's velocity sample looks, in milliseconds. */
const flickWindowMs = 90

export type LanternViewBasis = {
	origin: Vec3
	forward: Vec3
	right: Vec3
	up: Vec3
	zoom: number
}

export function lanternViewBasis(): LanternViewBasis {
	const { yaw, pitch, distance, target, zoom } = lanternCamera
	const origin = {
		x: target.x + distance * Math.cos(pitch) * Math.sin(yaw),
		y: target.y + distance * Math.sin(pitch),
		z: target.z + distance * Math.cos(pitch) * Math.cos(yaw),
	}
	const forward = normalize(sub(target, origin))
	const right = normalize(cross(forward, { x: 0, y: 1, z: 0 }))
	const up = cross(right, forward)
	return { origin, forward, right, up, zoom }
}

export type LanternProjection = {
	/** CSS pixels from the canvas's top left. */
	x: number
	y: number
	/** Distance in front of the camera, along its axis. */
	depth: number
	/** CSS pixels per world unit at that depth. */
	scale: number
}

/** Where a world point lands on a canvas `height` CSS pixels tall. */
export function projectLanternPoint(
	basis: LanternViewBasis,
	point: Vec3,
	size: { width: number; height: number },
): LanternProjection {
	const d = sub(point, basis.origin)
	const depth = Math.max(dot(d, basis.forward), 0.001)
	const scale = (basis.zoom * size.height) / depth
	return {
		x: size.width / 2 + dot(d, basis.right) * scale,
		y: size.height / 2 - dot(d, basis.up) * scale,
		depth,
		scale,
	}
}

/** Screen radius of a sphere's outline, in CSS pixels. */
export function projectedSphereRadius(
	basis: LanternViewBasis,
	centre: Vec3,
	radius: number,
	height: number,
) {
	const distance = length(sub(centre, basis.origin))
	const sine = Math.min(radius / Math.max(distance, radius + 0.001), 0.99)
	return basis.zoom * height * Math.tan(Math.asin(sine))
}

/** A pointer move in CSS pixels, as world movement at a given depth. */
export function screenDeltaToWorld(
	basis: LanternViewBasis,
	dx: number,
	dy: number,
	depth: number,
	height: number,
): Vec3 {
	const perPixel = depth / (basis.zoom * height)
	return add(
		scaleVec(basis.right, dx * perPixel),
		scaleVec(basis.up, -dy * perPixel),
	)
}

/** The lantern's frame to world space: the scene's `rotate-y: --yaw`. */
export function localToWorld(point: Vec3, yaw: number): Vec3 {
	return rotateAboutY(point, -yaw)
}

/** World space to the lantern's frame. */
export function worldToLocal(point: Vec3, yaw: number): Vec3 {
	return rotateAboutY(point, yaw)
}

/** The yaw that brings a local point around to face the camera. */
function yawFacingCamera(point: Vec3, currentYaw: number) {
	const facing = -Math.atan2(point.x, point.z)
	return currentYaw + wrapAngle(facing - currentYaw)
}

function wrapAngle(angle: number) {
	return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI))
}

export type LanternOrbit = {
	/** Turntable angle the user set, radians, unbounded. */
	yaw: number
	yawVelocity: number
	/** A keyboard or focus turn in progress, radians. */
	yawTarget: number | null
	/** 0 while the user holds the lantern, easing back to 1 after. */
	sway: number
}

const swayYaw = 13 * degrees
const swayRate = 0.32
const spinFriction = 1.6
const turnSpring = 40
const turnDamping = 12
const swayReturnSeconds = 3.5

export function createLanternOrbit(): LanternOrbit {
	return { yaw: 0, yawVelocity: 0, yawTarget: null, sway: 1 }
}

/** Advance the orbit one frame. Does not mutate `orbit`. */
export function stepLanternOrbit(
	orbit: LanternOrbit,
	dtSeconds: number,
	options: { held: boolean; motion: boolean },
): LanternOrbit {
	const dt = clampDt(dtSeconds)
	const next = { ...orbit }
	if (options.held) {
		next.sway = 0
		return next
	}
	if (!options.motion) {
		return {
			...next,
			yaw: next.yawTarget ?? next.yaw,
			yawVelocity: 0,
			yawTarget: null,
			sway: 0,
		}
	}
	if (next.yawTarget !== null) {
		const offset = next.yawTarget - next.yaw
		next.yawVelocity +=
			(offset * turnSpring - next.yawVelocity * turnDamping) * dt
		if (Math.abs(offset) < 0.002 && Math.abs(next.yawVelocity) < 0.01) {
			next.yaw = next.yawTarget
			next.yawVelocity = 0
			next.yawTarget = null
		}
	} else {
		next.yawVelocity *= Math.exp(-spinFriction * dt)
		if (Math.abs(next.yawVelocity) < 0.004) next.yawVelocity = 0
	}
	next.yaw += next.yawVelocity * dt
	next.sway = Math.min(1, next.sway + dt / swayReturnSeconds)
	return next
}

/** Take hold of the lantern. The sway it was showing becomes its pose, so
 *  a grab does not jump; the sway eases back in after the release. */
export function holdLanternOrbit(
	orbit: LanternOrbit,
	time: number,
): LanternOrbit {
	const pose = lanternPose(orbit, time)
	return { ...orbit, yaw: pose.yaw, yawVelocity: 0, yawTarget: null, sway: 0 }
}

/** Turn so a local point faces the camera, from wherever the sway left it. */
export function turnLanternTo(
	orbit: LanternOrbit,
	time: number,
	point: Vec3,
): LanternOrbit {
	const held = holdLanternOrbit(orbit, time)
	return { ...held, yawTarget: yawFacingCamera(point, held.yaw) }
}

/** The pose the scene draws: the user's orbit plus the idle sway. */
export function lanternPose(orbit: LanternOrbit, time: number) {
	return {
		yaw: orbit.yaw + Math.sin(time * swayRate) * swayYaw * smooth(orbit.sway),
	}
}

export type LanternOrbBody = {
	id: LandingPrimitiveId
	position: Vec3
	velocity: Vec3
	phase: number
	/** Hover and grab grow an orb; collisions use the grown radius. */
	scale: number
	/** A grab or a knock is still carrying this orb. */
	coasting: boolean
}

export type LanternOrbHold = {
	id: LandingPrimitiveId
	position: Vec3
	velocity: Vec3
}

export type LanternPointerSample = { position: Vec3; t: number }

export function createLanternOrbBodies(): Array<LanternOrbBody> {
	return landingPrimitiveIds.map((id) => ({
		id,
		position: { ...lanternOrbHomes[id] },
		velocity: { x: 0, y: 0, z: 0 },
		phase: phases[id],
		scale: 1,
		coasting: false,
	}))
}

/** Local-space velocity from the recent end of a drag. */
export function lanternFlickVelocity(
	samples: ReadonlyArray<LanternPointerSample>,
	now: number,
): Vec3 {
	const recent = samples.filter((sample) => now - sample.t <= flickWindowMs)
	const first = recent[0]
	const last = recent.at(-1)
	if (!first || !last || first === last) return { x: 0, y: 0, z: 0 }
	const dt = (last.t - first.t) / 1000
	if (dt <= 0.012) return { x: 0, y: 0, z: 0 }
	return capVec(
		scaleVec(sub(last.position, first.position), 1 / dt),
		coastMaxSpeed,
	)
}

/**
 * Advance the orbs one frame in the lantern's frame. `amplitude` is 1 for
 * full drift and 0 to hold every orb at home. `spin` is how far the
 * lantern turned this frame, so the orbs can lag behind it. Does not
 * mutate `bodies`.
 */
export function stepLanternOrbs(
	bodies: ReadonlyArray<LanternOrbBody>,
	dtSeconds: number,
	options: {
		time: number
		amplitude: number
		spin?: number
		hold?: LanternOrbHold | null
	},
): Array<LanternOrbBody> {
	const dt = clampDt(dtSeconds)
	const amplitude = Math.min(Math.max(options.amplitude, 0), 1)
	const hold = options.hold ?? null
	const spin = amplitude > 0 ? (options.spin ?? 0) : 0
	const omega = dt > 0 ? spin / dt : 0
	const next = bodies.map((body) => ({
		...body,
		position: { ...body.position },
		velocity: { ...body.velocity },
	}))
	for (const body of next) {
		if (hold && body.id === hold.id) {
			placeHeld(body, hold)
			continue
		}
		if (spin !== 0) dragBySpin(body, spin, omega, dt)
		if (body.coasting) integrateCoast(body, dt)
		else integrateFloat(body, dt, options.time, amplitude)
	}
	for (let pass = 0; pass < 4; pass++) {
		separateOrbs(next, hold?.id ?? null)
		containOrbs(next, hold?.id ?? null)
		if (hold) {
			const held = next.find((body) => body.id === hold.id)
			if (held) placeHeld(held, hold)
		}
	}
	separateOrbs(next, hold?.id ?? null)
	containOrbs(next, hold?.id ?? null)
	for (const body of next) {
		if (hold && body.id === hold.id) continue
		if (!body.coasting) continue
		if (length(body.velocity) >= coastSettleSpeed) continue
		body.coasting = false
	}
	return next
}

/** Every orb gets a random knock, as if the lantern were tapped. */
export function pokeLanternOrbs(
	bodies: ReadonlyArray<LanternOrbBody>,
	random: () => number = Math.random,
): Array<LanternOrbBody> {
	return bodies.map((body) => {
		const kick = normalize({
			x: random() - 0.5,
			y: random() - 0.35,
			z: random() - 0.5,
		})
		return {
			...body,
			velocity: capVec(
				add(body.velocity, scaleVec(kick, 0.9 + random() * 0.6)),
				coastMaxSpeed,
			),
			coasting: true,
		}
	})
}

/** Keep a centre inside the glass, clear of the cap, the base, and Kody. */
function clampToLanternCavity(point: Vec3, radius: number): Vec3 {
	const limit = cavity.radius - radius - wallSkin
	const distance = length(point)
	let next = point
	if (distance > limit && distance > 0) next = scaleVec(point, limit / distance)
	const top = cavity.top - radius - wallSkin
	const bottom = cavity.bottom + radius + wallSkin
	next = { ...next, y: Math.min(top, Math.max(bottom, next.y)) }
	return pushOffKody(next, radius)?.point ?? next
}

/** A centre inside Kody's capsule, moved straight out from the axis to its
 *  surface along `normal`. Out from the axis, never up or down, so an orb
 *  over the flame or under his chin is not pushed into the cap or the
 *  base. Null when the orb is clear of him. */
function pushOffKody(point: Vec3, radius: number) {
	const clear = kody.radius + radius + wallSkin
	const beyond = Math.max(point.y - kody.top, kody.bottom - point.y, 0)
	if (beyond >= clear) return null
	const reach = Math.sqrt(clear * clear - beyond * beyond)
	const out = Math.hypot(point.x, point.z)
	if (out >= reach) return null
	const normal =
		out === 0
			? { x: 0, y: 0, z: 1 }
			: { x: point.x / out, y: 0, z: point.z / out }
	return {
		point: { x: normal.x * reach, y: point.y, z: normal.z * reach },
		normal,
	}
}

function bodyRadius(body: LanternOrbBody) {
	return lanternOrbRadius * body.scale
}

function wanderTarget(body: LanternOrbBody, time: number, amplitude: number) {
	const home = lanternOrbHomes[body.id]
	const reach = roam * amplitude
	const angle = time * wanderRate + body.phase
	const target = {
		x: home.x + Math.cos(angle) * reach,
		y: home.y + Math.sin(angle * 0.76 + 0.7) * reach * roamRise,
		z: home.z + Math.sin(angle * 0.53 + 1.9) * reach * 0.8,
	}
	return clampToLanternCavity(target, bodyRadius(body))
}

function integrateFloat(
	body: LanternOrbBody,
	dt: number,
	time: number,
	amplitude: number,
) {
	const target = wanderTarget(body, time, amplitude)
	const pull = scaleVec(sub(target, body.position), spring * dt)
	body.velocity = scaleVec(add(body.velocity, pull), Math.exp(-damping * dt))
	body.velocity = capVec(body.velocity, floatMaxSpeed)
	body.position = add(body.position, scaleVec(body.velocity, dt))
}

function integrateCoast(body: LanternOrbBody, dt: number) {
	body.velocity = capVec(
		scaleVec(body.velocity, Math.exp(-coastDamping * dt)),
		coastMaxSpeed,
	)
	body.position = add(body.position, scaleVec(body.velocity, dt))
}

/** The lantern turned by `spin` this frame: the orbs keep part of their
 *  world position (they slip), and a fast spin flings them outward. */
function dragBySpin(
	body: LanternOrbBody,
	spin: number,
	omega: number,
	dt: number,
) {
	body.position = rotateAboutY(body.position, spin * spinSlip)
	const fling = omega * omega * spinFling * dt
	if (fling < 0.002) return
	body.velocity = add(body.velocity, {
		x: body.position.x * fling,
		y: 0,
		z: body.position.z * fling,
	})
	if (length(body.velocity) > floatMaxSpeed) body.coasting = true
}

function placeHeld(body: LanternOrbBody, hold: LanternOrbHold) {
	body.position = clampToLanternCavity(hold.position, bodyRadius(body))
	body.velocity = capVec(hold.velocity, coastMaxSpeed)
	body.coasting = true
}

function separateOrbs(
	bodies: Array<LanternOrbBody>,
	heldId: LandingPrimitiveId | null,
) {
	for (let i = 0; i < bodies.length; i++) {
		const a = bodies[i]!
		for (let j = i + 1; j < bodies.length; j++) {
			const b = bodies[j]!
			const delta = sub(b.position, a.position)
			const distance = length(delta)
			const min = bodyRadius(a) + bodyRadius(b)
			if (distance >= min) continue
			const normal =
				distance === 0 ? { x: 1, y: 0, z: 0 } : scaleVec(delta, 1 / distance)
			const overlap = min - distance
			const aHeld = heldId !== null && a.id === heldId
			const bHeld = heldId !== null && b.id === heldId
			if (aHeld || bHeld) {
				const free = aHeld ? b : a
				const wall = aHeld ? a : b
				const away = aHeld ? normal : scaleVec(normal, -1)
				free.position = add(free.position, scaleVec(away, overlap))
				shove(free, wall.velocity, away)
				continue
			}
			a.position = sub(a.position, scaleVec(normal, overlap * 0.5))
			b.position = add(b.position, scaleVec(normal, overlap * 0.5))
			const closing = dot(sub(a.velocity, b.velocity), normal)
			if (closing <= 0) continue
			const share = !a.coasting && !b.coasting ? 0.5 : (1 + restitution) * 0.5
			a.velocity = sub(a.velocity, scaleVec(normal, closing * share))
			b.velocity = add(b.velocity, scaleVec(normal, closing * share))
			if (a.coasting || b.coasting) {
				kick(a)
				kick(b)
			}
		}
	}
}

/** Push `body` as if it hit an immovable orb moving at `velocity`. */
function shove(body: LanternOrbBody, velocity: Vec3, normal: Vec3) {
	const approach = dot(sub(velocity, body.velocity), normal)
	if (approach <= 0) return
	body.velocity = capVec(
		add(body.velocity, scaleVec(normal, (1 + restitution) * approach)),
		coastMaxSpeed,
	)
	kick(body)
}

function kick(body: LanternOrbBody) {
	if (length(body.velocity) > coastSettleSpeed) body.coasting = true
}

function containOrbs(
	bodies: Array<LanternOrbBody>,
	heldId: LandingPrimitiveId | null,
) {
	for (const body of bodies) {
		if (heldId !== null && body.id === heldId) continue
		const radius = bodyRadius(body)
		const limit = cavity.radius - radius - wallSkin
		const distance = length(body.position)
		if (distance > limit && distance > 0) {
			const normal = scaleVec(body.position, 1 / distance)
			body.position = scaleVec(normal, limit)
			body.velocity = bounce(body, normal)
		}
		const top = cavity.top - radius - wallSkin
		const bottom = cavity.bottom + radius + wallSkin
		if (body.position.y > top) {
			body.position = { ...body.position, y: top }
			body.velocity = bounce(body, { x: 0, y: 1, z: 0 })
		} else if (body.position.y < bottom) {
			body.position = { ...body.position, y: bottom }
			body.velocity = bounce(body, { x: 0, y: -1, z: 0 })
		}
		const pushed = pushOffKody(body.position, radius)
		if (pushed) {
			body.position = pushed.point
			body.velocity = bounce(body, scaleVec(pushed.normal, -1))
		}
	}
}

/** Off the wall at `normal` (pointing out): a toss bounces, a drift slides. */
function bounce(body: LanternOrbBody, normal: Vec3): Vec3 {
	const outward = dot(body.velocity, normal)
	if (outward <= 0) return body.velocity
	const keep = body.coasting ? 1 + restitution : 1
	return sub(body.velocity, scaleVec(normal, outward * keep))
}

/** Seconds the lantern sits untouched before Kody's idle moment, and
 *  between moments after that. */
export const lanternIdleDelay = 10
const idleRepeat = 40
const idleLength = 3.8
/** When the first orb pops, seconds into the moment, then each next. */
const idleFirstPop = 0.7
const idlePopStep = 0.36
const idlePopHalf = 0.3
const idleFlareAt = 3.05
const idleBowAt = 3.1

export type LanternIdleMoment = {
	/** How far Kody's gaze is on the orbs, 0 to 1. */
	gaze: number
	/** The orb he looks at, as a place down the spiral: 0 is the first
	 *  word's orb, 5 the last's, 2.5 halfway between the third and fourth. */
	focus: number
	/** Each orb's pop, 0 to 1. */
	pop: Record<LandingPrimitiveId, number>
	/** The flame's flare once he is done, 0 to 1. */
	flare: number
	/** His satisfied nod at the end, 0 to 1. */
	bow: number
}

/**
 * Kody's idle moment `restSeconds` into a rest, or null between moments.
 * Left alone a while, he counts his marbles: his gaze runs down the spiral
 * as each orb pops in turn, then he nods and the flame flares. It comes
 * once after `lanternIdleDelay`, then rarely, so the page stays calm.
 */
export function lanternIdleMoment(
	restSeconds: number,
): LanternIdleMoment | null {
	if (restSeconds < lanternIdleDelay) return null
	const t = (restSeconds - lanternIdleDelay) % idleRepeat
	if (t >= idleLength) return null
	const last = landingPrimitiveIds.length - 1
	const pop = Object.fromEntries(
		landingPrimitiveIds.map((id, index) => [
			id,
			bump(t, idleFirstPop + index * idlePopStep, idlePopHalf),
		]),
	) as Record<LandingPrimitiveId, number>
	return {
		gaze:
			smooth(clamp(t / 0.6, 0, 1)) *
			(1 - smooth(clamp((t - (idleLength - 1)) / 0.8, 0, 1))),
		// A beat ahead of each pop: eyes lead.
		focus: clamp((t - idleFirstPop + 0.12) / idlePopStep, 0, last),
		pop,
		flare: bump(t, idleFlareAt, 0.6),
		bow: bump(t, idleBowAt, 0.24),
	}
}

const gazeLookLimit = 32 * degrees
const gazeNodLimit = 20 * degrees

/** The look (`rotate-y`, right is positive) and nod (`rotate-x`, up is
 *  positive) that point Kody's face at a world point. He cannot look
 *  behind himself: a point behind him gets a glance to that side. */
export function kodyGaze(target: Vec3) {
	const dx = target.x - kodyHead.x
	const dy = target.y - kodyHead.y
	const ahead = Math.max(target.z - kodyHead.z, 0) + 0.3
	return {
		look: clamp(Math.atan2(dx, ahead), -gazeLookLimit, gazeLookLimit),
		nod: clamp(
			Math.atan2(dy, Math.hypot(dx, ahead)),
			-gazeNodLimit,
			gazeNodLimit,
		),
	}
}

/**
 * Warm-up: before the crossfade, the scene has to show it keeps up. Past
 * the first frames (shader warm-up), it gets a short window at full
 * resolution, then one at the lowest resolution the screen allows. A
 * second frame slower than `warmupStallMs` ends it: that is a software
 * renderer or a GPU far too weak for the scene, and the still lantern
 * stays. The first is forgiven, since a long task elsewhere on the page
 * stalls a frame just the same.
 */
export type LanternWarmup = {
	stage: 'full' | 'floor' | 'done'
	/** Frames still to skip before measuring. */
	settle: number
	/** Frames slower than `warmupStallMs` so far. */
	stalls: number
	windowStart: number
	frames: number
	lastFrame: number
}

export type LanternWarmupVerdict = 'wait' | 'lower' | 'show' | 'slow'

const warmupSettleFrames = 3
const warmupWindowMs = 600
const warmupFullFps = 24
const warmupFloorFps = 20
const warmupStallMs = 250
const warmupStallLimit = 2

export function createLanternWarmup(now: number): LanternWarmup {
	return {
		stage: 'full',
		settle: warmupSettleFrames,
		stalls: 0,
		windowStart: now,
		frames: 0,
		lastFrame: now,
	}
}

/** The frame loop stopped (hidden tab, scrolled away): measure afresh
 *  from the next frame, so the gap does not read as a slow frame. */
export function resumeLanternWarmup(
	state: LanternWarmup,
	now: number,
): LanternWarmup {
	if (state.stage === 'done') return state
	return {
		...state,
		settle: Math.max(state.settle, 1),
		windowStart: now,
		frames: 0,
		lastFrame: now,
	}
}

/** Count one frame drawn at `now`. Does not mutate `state`. `lower`
 *  asks for the lowest resolution before the next window. */
export function stepLanternWarmup(
	state: LanternWarmup,
	now: number,
): { state: LanternWarmup; verdict: LanternWarmupVerdict } {
	if (state.stage === 'done') return { state, verdict: 'wait' }
	if (state.settle > 0) {
		return {
			state: {
				...state,
				settle: state.settle - 1,
				windowStart: now,
				frames: 0,
				lastFrame: now,
			},
			verdict: 'wait',
		}
	}
	if (now - state.lastFrame > warmupStallMs) {
		const stalls = state.stalls + 1
		if (stalls >= warmupStallLimit) {
			return { state: { ...state, stage: 'done', stalls }, verdict: 'slow' }
		}
		return {
			state: { ...state, stalls, windowStart: now, frames: 0, lastFrame: now },
			verdict: 'wait',
		}
	}
	const next = { ...state, frames: state.frames + 1, lastFrame: now }
	const span = now - state.windowStart
	if (span < warmupWindowMs) return { state: next, verdict: 'wait' }
	const fps = (next.frames * 1000) / span
	const floor = state.stage === 'full' ? warmupFullFps : warmupFloorFps
	if (fps >= floor) {
		return { state: { ...next, stage: 'done' }, verdict: 'show' }
	}
	if (state.stage === 'full') {
		return {
			state: {
				stage: 'floor',
				// The canvas resizes for the new resolution first.
				settle: 2,
				stalls: state.stalls,
				windowStart: now,
				frames: 0,
				lastFrame: now,
			},
			verdict: 'lower',
		}
	}
	return { state: { ...next, stage: 'done' }, verdict: 'slow' }
}

/** Adaptive resolution: the share of the device pixel ratio the canvas
 *  renders at, stepped down when frames drop and back up after a calm
 *  stretch. It aims for the display's rate, measured before the scene
 *  drew, up to 60 fps: a 30 Hz power-saving display is not mistaken for a
 *  slow GPU, and a 120 Hz display does not blur the lantern past 60. */
export type LanternResolution = {
	scale: number
	/** The lowest scale this screen may step down to. */
	floor: number
	targetFps: number
	/** A level that dropped frames, and when it may be tried again. */
	ceiling: number
	retryAt: number
	windowStart: number
	frames: number
	lastFrame: number
	calmSince: number
	settleUntil: number
}

const resolutionStep = 0.125
const resolutionWindowMs = 500
/** A longer gap is a pause (hidden tab, scrolled away), not a slow frame. */
const resolutionGapMs = 250
/** Shader warm-up and texture uploads stutter the first frames. */
const resolutionSettleMs = 1500
const resolutionClimbMs = 3000
const resolutionRetryMs = 20_000

/** GSS sizes the canvas at up to 2 device pixels per CSS pixel. Never drop
 *  under 0.75 device pixels per CSS pixel, or under half of what GSS
 *  draws: past that the lantern reads as blurred, not as a lighter frame. */
function lanternResolutionFloor(devicePixelRatio: number) {
	const density = Math.min(Math.max(devicePixelRatio, 1), 2)
	const floor = Math.ceil(0.75 / density / resolutionStep) * resolutionStep
	return Math.min(1, Math.max(0.5, floor))
}

export function createLanternResolution(
	refreshFps: number,
	devicePixelRatio: number,
	now: number,
): LanternResolution {
	return {
		scale: 1,
		floor: lanternResolutionFloor(devicePixelRatio),
		targetFps: Math.min(Math.max(refreshFps, 30), 60),
		ceiling: 1,
		retryAt: 0,
		windowStart: now,
		frames: 0,
		lastFrame: now,
		calmSince: now,
		settleUntil: now + resolutionSettleMs,
	}
}

/** Count one frame drawn at `now`. Does not mutate `state`. */
export function stepLanternResolution(
	state: LanternResolution,
	now: number,
): LanternResolution {
	const next = { ...state }
	if (now - state.lastFrame > resolutionGapMs) {
		next.windowStart = now
		next.frames = 0
		next.lastFrame = now
		next.settleUntil = Math.max(state.settleUntil, now + resolutionWindowMs)
		return next
	}
	next.lastFrame = now
	if (now < state.settleUntil) {
		next.windowStart = now
		next.frames = 0
		next.calmSince = now
		return next
	}
	next.frames += 1
	const span = now - state.windowStart
	if (span < resolutionWindowMs) return next
	const fps = (next.frames * 1000) / span
	next.windowStart = now
	next.frames = 0
	if (fps < state.targetFps * 0.75) {
		next.calmSince = now
		if (state.scale <= state.floor) return next
		// Pixels cost linearly, so scale each side by the root of the shortfall.
		const wanted = state.scale * Math.sqrt(fps / (state.targetFps * 0.9))
		next.scale = Math.max(
			state.floor,
			Math.min(
				state.scale - resolutionStep,
				Math.floor(wanted / resolutionStep) * resolutionStep,
			),
		)
		next.ceiling = state.scale
		next.retryAt = now + resolutionRetryMs
		next.settleUntil = now + resolutionWindowMs
		return next
	}
	if (fps < state.targetFps * 0.95) {
		next.calmSince = now
		return next
	}
	if (state.scale >= 1 || now - state.calmSince < resolutionClimbMs) return next
	const up = Math.min(1, state.scale + resolutionStep)
	if (up >= state.ceiling && now < state.retryAt) return next
	next.scale = up
	next.calmSince = now
	next.settleUntil = now + resolutionWindowMs
	return next
}

function rotateAboutY(point: Vec3, angle: number): Vec3 {
	const c = Math.cos(angle)
	const s = Math.sin(angle)
	return {
		x: c * point.x - s * point.z,
		y: point.y,
		z: s * point.x + c * point.z,
	}
}

function clampDt(dtSeconds: number) {
	return Math.min(Math.max(dtSeconds, 0), 1 / 30)
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value))
}

/** Smoothstep on 0 to 1. */
function smooth(t: number) {
	return t * t * (3 - 2 * t)
}

/** A smooth hill: 1 at `centre`, 0 from `half` away on either side. */
function bump(t: number, centre: number, half: number) {
	const offset = Math.abs(t - centre) / half
	return offset >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * offset)
}

function add(a: Vec3, b: Vec3): Vec3 {
	return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

function sub(a: Vec3, b: Vec3): Vec3 {
	return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function scaleVec(a: Vec3, s: number): Vec3 {
	return { x: a.x * s, y: a.y * s, z: a.z * s }
}

function dot(a: Vec3, b: Vec3) {
	return a.x * b.x + a.y * b.y + a.z * b.z
}

function cross(a: Vec3, b: Vec3): Vec3 {
	return {
		x: a.y * b.z - a.z * b.y,
		y: a.z * b.x - a.x * b.z,
		z: a.x * b.y - a.y * b.x,
	}
}

function length(a: Vec3) {
	return Math.hypot(a.x, a.y, a.z)
}

function normalize(a: Vec3): Vec3 {
	const size = length(a)
	return size === 0 ? { x: 0, y: 0, z: 0 } : scaleVec(a, 1 / size)
}

function capVec(a: Vec3, limit: number): Vec3 {
	const size = length(a)
	return size <= limit || size === 0 ? a : scaleVec(a, limit / size)
}
