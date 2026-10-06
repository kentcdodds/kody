import { expect, test } from 'vitest'
import {
	createLanternOrbBodies,
	createLanternOrbit,
	createLanternResolution,
	createLanternWarmup,
	holdLanternOrbit,
	lanternFlickVelocity,
	lanternGlobeRadius,
	lanternOrbRadius,
	lanternPose,
	lanternViewBasis,
	localToWorld,
	pokeLanternOrbs,
	projectLanternPoint,
	projectedSphereRadius,
	resumeLanternWarmup,
	screenDeltaToWorld,
	stepLanternOrbit,
	stepLanternOrbs,
	stepLanternResolution,
	stepLanternWarmup,
	turnLanternTo,
	worldToLocal,
	type LanternOrbBody,
	type LanternOrbit,
	type LanternResolution,
	type LanternWarmup,
	type LanternWarmupVerdict,
	type Vec3,
} from './landing-lantern-3d-motion.ts'

const frame = 1 / 60

/** Under the cap and over the base plate in landing-lantern-3d.gss. */
const capUnderside = 0.695
const basePlate = -0.695

function length(v: Vec3) {
	return Math.hypot(v.x, v.y, v.z)
}

function distance(a: Vec3, b: Vec3) {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function expectInsideLantern(bodies: ReadonlyArray<LanternOrbBody>) {
	for (const body of bodies) {
		const radius = lanternOrbRadius * body.scale
		expect(length(body.position) + radius).toBeLessThan(lanternGlobeRadius)
		expect(body.position.y + radius).toBeLessThan(capUnderside)
		expect(body.position.y - radius).toBeGreaterThan(basePlate)
	}
}

function closestPair(bodies: ReadonlyArray<LanternOrbBody>) {
	let closest = Infinity
	for (let i = 0; i < bodies.length; i++) {
		for (let j = i + 1; j < bodies.length; j++) {
			closest = Math.min(
				closest,
				distance(bodies[i]!.position, bodies[j]!.position),
			)
		}
	}
	return closest
}

function seededRandom(seed: number) {
	let state = seed
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
		return state / 4_294_967_296
	}
}

function runOrbit(orbit: LanternOrbit, seconds: number, motion = true) {
	let next = orbit
	for (let t = 0; t < seconds; t += frame) {
		next = stepLanternOrbit(next, frame, { held: false, motion })
	}
	return next
}

/** A GPU that takes `fullMs` per frame at full resolution. Pixels cost
 *  linearly and the display caps it at `refreshFps`. */
function gpu(fullMs: number, refreshFps = 60) {
	return (scale: number) => Math.max(1000 / refreshFps, fullMs * scale * scale)
}

function runResolution(
	state: LanternResolution,
	frameMs: (scale: number) => number,
	seconds: number,
) {
	let next = state
	let lowest = state.scale
	let now = state.lastFrame
	const end = now + seconds * 1000
	while (now < end) {
		now += frameMs(next.scale)
		next = stepLanternResolution(next, now)
		lowest = Math.min(lowest, next.scale)
	}
	return { state: next, lowest }
}

/** Frames until the warm-up decides, each `frameMs(stage, index)` long. */
function runWarmup(
	frameMs: (stage: LanternWarmup['stage'], index: number) => number,
	seconds = 10,
) {
	let state = createLanternWarmup(0)
	let now = 0
	const verdicts: Array<LanternWarmupVerdict> = []
	for (let index = 0; now < seconds * 1000; index++) {
		now += frameMs(state.stage, index)
		const step = stepLanternWarmup(state, now)
		state = step.state
		if (step.verdict === 'wait') continue
		verdicts.push(step.verdict)
		if (state.stage === 'done') break
	}
	return { verdicts, now, state }
}

test('the projection lands the globe and an orb where GSS draws them', () => {
	// Measured from gss-lang 0.0.5 renders with the scene's camera on a
	// 600 by 864 canvas: a 0.97 sphere at the pivot spans x 11.5% to 88.3%
	// and y 28.1% to 81.6%; a 0.05 sphere at (0.5, 0.3, 0.4) spans x 69.0%
	// to 73.3% and y 47.1% to 50.0%.
	const basis = lanternViewBasis()
	const size = { width: 600, height: 864 }
	const pivot = { x: 0, y: 0, z: 0 }
	const globe = projectLanternPoint(basis, pivot, size)
	const globeRadius = projectedSphereRadius(
		basis,
		pivot,
		lanternGlobeRadius,
		size.height,
	)
	expect(globe.x / size.width).toBeCloseTo(0.499, 2)
	expect(globe.y / size.height).toBeCloseTo(0.5485, 2)
	expect(globeRadius / size.width).toBeCloseTo(0.384, 2)
	expect(globeRadius / size.height).toBeCloseTo(0.2675, 2)

	const orb = { x: 0.5, y: 0.3, z: 0.4 }
	const point = projectLanternPoint(basis, orb, size)
	expect(point.x / size.width).toBeCloseTo(0.7115, 2)
	expect(point.y / size.height).toBeCloseTo(0.4855, 2)
	expect(
		projectedSphereRadius(basis, orb, 0.05, size.height) / size.width,
	).toBeCloseTo(0.0215, 2)
	// Nearer the camera than the pivot, so drawn bigger per world unit.
	expect(point.depth).toBeLessThan(globe.depth)
	expect(point.scale).toBeGreaterThan(globe.scale)

	// A pointer drag at the orb's depth moves its projection by the drag.
	const delta = screenDeltaToWorld(basis, 30, -20, point.depth, size.height)
	const dragged = projectLanternPoint(
		basis,
		{ x: orb.x + delta.x, y: orb.y + delta.y, z: orb.z + delta.z },
		size,
	)
	expect(dragged.x - point.x).toBeCloseTo(30, 6)
	expect(dragged.y - point.y).toBeCloseTo(-20, 6)
	expect(dragged.depth).toBeCloseTo(point.depth, 6)
})

test('the lantern frame turns the front toward the drag and round trips', () => {
	const basis = lanternViewBasis()
	const size = { width: 600, height: 864 }
	const front = { x: 0, y: 0, z: 0.5 }
	const centre = projectLanternPoint(basis, front, size)
	// Dragging right turns the lantern the same way the body turns in GSS:
	// its front swings right, then round to the back (farther away).
	const quarter = projectLanternPoint(
		basis,
		localToWorld(front, Math.PI / 4),
		size,
	)
	expect(quarter.x).toBeGreaterThan(centre.x)
	expect(quarter.depth).toBeGreaterThan(centre.depth)

	// A turn about the axis keeps every height.
	const point = { x: 0.31, y: -0.2, z: 0.44 }
	const world = localToWorld(point, 2.4)
	expect(world.y).toBe(point.y)
	expect(length(world)).toBeCloseTo(length(point), 9)
	const back = worldToLocal(world, 2.4)
	expect(back.x).toBeCloseTo(point.x, 9)
	expect(back.y).toBeCloseTo(point.y, 9)
	expect(back.z).toBeCloseTo(point.z, 9)
})

test('the orbit sways at rest, freezes when held, coasts, and turns to an orb', () => {
	const rest = createLanternOrbit()
	const swaying = lanternPose(rest, 2)
	expect(Math.abs(swaying.yaw)).toBeGreaterThan(0.05)
	expect(Math.abs(swaying.yaw)).toBeLessThan(Math.PI / 12)

	// Grabbing keeps the pose the sway was showing, and the sway stops.
	const held = holdLanternOrbit(rest, 2)
	expect(lanternPose(held, 2).yaw).toBeCloseTo(swaying.yaw, 9)
	expect(lanternPose(held, 7).yaw).toBeCloseTo(swaying.yaw, 9)
	const stillHeld = stepLanternOrbit(held, frame, { held: true, motion: true })
	expect(stillHeld.yaw).toBe(held.yaw)

	// A flick coasts, slows, and stops.
	const flicked = { ...held, yawVelocity: 6 }
	const second = runOrbit(flicked, 1)
	expect(second.yaw).toBeGreaterThan(flicked.yaw + 1)
	expect(second.yawVelocity).toBeGreaterThan(0)
	expect(second.yawVelocity).toBeLessThan(6)
	const stopped = runOrbit(second, 10)
	expect(stopped.yawVelocity).toBe(0)
	expect(runOrbit(stopped, 1).yaw).toBe(stopped.yaw)
	// The sway eases back in after the release.
	expect(stopped.sway).toBe(1)

	// Turning to an orb brings it round to face the camera.
	const secrets = createLanternOrbBodies().find((body) => body.id === 'secrets')
	if (!secrets) throw new Error('missing secrets orb')
	const turning = turnLanternTo(stopped, 12, secrets.position)
	expect(Math.abs(turning.yawTarget! - turning.yaw)).toBeLessThanOrEqual(
		Math.PI,
	)
	const turned = runOrbit(turning, 3)
	expect(turned.yawTarget).toBeNull()
	const facing = localToWorld(secrets.position, turned.yaw)
	expect(facing.x).toBeCloseTo(0, 2)
	expect(facing.z).toBeGreaterThan(0)

	// Reduced motion jumps straight there and drops the sway.
	const jumped = stepLanternOrbit(turning, frame, {
		held: false,
		motion: false,
	})
	expect(jumped.yaw).toBe(turning.yawTarget)
	expect(jumped.yawTarget).toBeNull()
	expect(lanternPose(jumped, 30).yaw).toBe(jumped.yaw)
})

test('orbs drift inside the glass without touching and rest at home when still', () => {
	const homes = createLanternOrbBodies()
	expectInsideLantern(homes)
	expect(closestPair(homes)).toBeGreaterThanOrEqual(lanternOrbRadius * 2)

	let bodies = homes
	let farthest = 0
	for (let t = 0; t < 20; t += frame) {
		bodies = stepLanternOrbs(bodies, frame, { time: t, amplitude: 1 })
		expectInsideLantern(bodies)
		expect(closestPair(bodies)).toBeGreaterThan(lanternOrbRadius * 2 - 0.005)
		for (const body of bodies) {
			const home = homes.find((entry) => entry.id === body.id)!
			farthest = Math.max(farthest, distance(body.position, home.position))
		}
	}
	// A lazy drift around home, not a wander across the globe.
	expect(farthest).toBeGreaterThan(0.03)
	expect(farthest).toBeLessThan(0.2)
	expect(bodies.every((body) => !body.coasting)).toBe(true)

	for (let t = 20; t < 30; t += frame) {
		bodies = stepLanternOrbs(bodies, frame, { time: t, amplitude: 0 })
	}
	for (const body of bodies) {
		const home = homes.find((entry) => entry.id === body.id)!
		expect(distance(body.position, home.position)).toBeLessThan(0.01)
	}

	// The lantern turning drags the orbs round, but they lag behind it.
	const spin = 0.15
	const before = localToWorld(bodies[0]!.position, 0)
	const spun = stepLanternOrbs(bodies, frame, {
		time: 30,
		amplitude: 1,
		spin,
	})
	const after = localToWorld(spun[0]!.position, spin)
	const turned = Math.atan2(after.x, after.z) - Math.atan2(before.x, before.z)
	expect(turned).toBeGreaterThan(0)
	expect(turned).toBeLessThan(spin)
})

test('a tossed orb bounces off the glass, knocks the others, and settles', () => {
	let bodies = createLanternOrbBodies()
	// Dragged past the glass: the held orb stays inside.
	bodies = stepLanternOrbs(bodies, frame, {
		time: 0,
		amplitude: 1,
		hold: {
			id: 'memory',
			position: { x: 2, y: 0, z: 0 },
			velocity: { x: 0, y: 0, z: 0 },
		},
	})
	expectInsideLantern(bodies)
	const memory = () => bodies.find((body) => body.id === 'memory')!
	expect(memory().position.x).toBeGreaterThan(0.5)

	// Released mid-flick, as the engine does on pointerup.
	bodies = stepLanternOrbs(bodies, 0, {
		time: 0,
		amplitude: 1,
		hold: {
			id: 'memory',
			position: memory().position,
			velocity: { x: -4, y: 0.4, z: 0 },
		},
	})
	expect(memory().coasting).toBe(true)
	let bounced = false
	const knocked = new Set<string>()
	let settledAt: number | null = null
	for (let t = 0; t < 12; t += frame) {
		bodies = stepLanternOrbs(bodies, frame, { time: t, amplitude: 1 })
		expectInsideLantern(bodies)
		if (memory().velocity.x > 0) bounced = true
		for (const body of bodies) {
			if (body.id !== 'memory' && body.coasting) knocked.add(body.id)
		}
		if (settledAt === null && bodies.every((body) => !body.coasting)) {
			settledAt = t
		}
	}
	expect(bounced).toBe(true)
	expect(knocked.size).toBeGreaterThan(0)
	expect(settledAt).not.toBeNull()
	expect(closestPair(bodies)).toBeGreaterThan(lanternOrbRadius * 2 - 0.005)

	// A tap knocks every orb about; they all settle back into the drift.
	bodies = pokeLanternOrbs(bodies, seededRandom(7))
	expect(bodies.every((body) => body.coasting)).toBe(true)
	expect(
		Math.min(...bodies.map((body) => length(body.velocity))),
	).toBeGreaterThan(0.5)
	for (let t = 12; t < 24; t += frame) {
		bodies = stepLanternOrbs(bodies, frame, { time: t, amplitude: 1 })
		expectInsideLantern(bodies)
	}
	expect(bodies.every((body) => !body.coasting)).toBe(true)
	expect(closestPair(bodies)).toBeGreaterThan(lanternOrbRadius * 2 - 0.005)
})

test('a flick reads the end of the drag, not the whole drag', () => {
	const steady = Array.from({ length: 21 }, (_, index) => ({
		position: { x: index * 0.01, y: 0, z: 0 },
		t: index * 10,
	}))
	const velocity = lanternFlickVelocity(steady, 200)
	expect(velocity.x).toBeCloseTo(1, 6)
	expect(velocity.y).toBe(0)

	// Fast at first, then held still: the release does not throw it.
	const stopped = steady.map((sample) => ({
		...sample,
		position: { x: Math.min(sample.t, 100) * 0.05, y: 0, z: 0 },
	}))
	expect(length(lanternFlickVelocity(stopped, 200))).toBe(0)
	// A drag that ended a while ago is not a flick.
	expect(length(lanternFlickVelocity(steady, 400))).toBe(0)

	// A wild flick keeps its direction but not its speed.
	const wild = steady.map((sample) => ({
		...sample,
		position: { x: 0, y: sample.t * 0.1, z: 0 },
	}))
	const capped = lanternFlickVelocity(wild, 200)
	expect(capped.x).toBe(0)
	expect(capped.y).toBeGreaterThan(1)
	expect(capped.y).toBeLessThan(100)
})

test('adaptive resolution settles at the sharpest level the GPU holds', () => {
	// Shader warm-up stutters do not count.
	const fresh = createLanternResolution(60, 2, 0)
	expect(runResolution(fresh, () => 100, 1).state.scale).toBe(1)

	const smooth = runResolution(fresh, gpu(8), 3)
	expect(smooth.lowest).toBe(1)

	// A long gap is a pause (hidden tab, scrolled away), not a slow frame.
	const paused = stepLanternResolution(
		smooth.state,
		smooth.state.lastFrame + 2000,
	)
	expect(runResolution(paused, gpu(8), 3).lowest).toBe(1)

	// 33 fps at full resolution: 3/4 still holds 60 fps, 7/8 does not.
	const heavy = runResolution(smooth.state, gpu(30), 12)
	expect(heavy.state.scale).toBe(0.75)
	expect(heavy.lowest).toBe(0.75)

	// The load goes away: it climbs back, retrying the level that dropped
	// frames only after a while.
	const light = runResolution(heavy.state, gpu(8), 6)
	expect(light.state.scale).toBe(0.75)
	expect(runResolution(light.state, gpu(8), 30).state.scale).toBe(1)

	// Far too slow: a 2x screen drops to 1x, a 1x screen keeps at least
	// 0.75 device pixels per CSS pixel.
	expect(runResolution(fresh, gpu(200), 10).lowest).toBe(0.5)
	const plain = createLanternResolution(60, 1, 0)
	expect(runResolution(plain, gpu(200), 10).lowest).toBe(0.75)

	// A 30 Hz display drawing every frame is not slow.
	const saver = createLanternResolution(30, 2, 0)
	expect(runResolution(saver, gpu(30, 30), 10).lowest).toBe(1)

	// A 120 Hz display at 83 fps is past 60, so it stays sharp. At 40 fps
	// it is not.
	const fast = createLanternResolution(120, 2, 0)
	expect(runResolution(fast, gpu(12, 120), 10).lowest).toBe(1)
	expect(runResolution(fast, gpu(25, 120), 10).lowest).toBeLessThan(1)
})

test('the warm-up shows a scene that keeps up and keeps the still otherwise', () => {
	// Compiling the shader stalls the first frames; they do not count.
	const smooth = runWarmup((_, index) => (index < 3 ? 900 : 1000 / 60))
	expect(smooth.verdicts).toEqual(['show'])
	expect(smooth.now).toBeLessThan(3 * 900 + 700)

	// Too slow at full resolution, fine at the lowest: lower, then show.
	expect(runWarmup((stage) => (stage === 'full' ? 50 : 25)).verdicts).toEqual([
		'lower',
		'show',
	])
	// Too slow even at the lowest.
	expect(runWarmup(() => 70).verdicts).toEqual(['lower', 'slow'])

	// A software renderer gives up within a couple of its frames.
	const software = runWarmup(() => 400)
	expect(software.verdicts).toEqual(['slow'])
	expect(software.now).toBeLessThanOrEqual(5 * 400)

	// One long task elsewhere on the page is forgiven; a second is not.
	expect(
		runWarmup((_, index) => (index === 8 ? 400 : 1000 / 60)).verdicts,
	).toEqual(['show'])
	expect(
		runWarmup((_, index) => (index === 8 || index === 20 ? 400 : 1000 / 60))
			.verdicts,
	).toEqual(['slow'])

	// A pause (a hidden tab) is not a slow frame.
	let state = createLanternWarmup(0)
	let now = 0
	for (let index = 0; index < 5; index++) {
		now += 16
		state = stepLanternWarmup(state, now).state
	}
	now += 5000
	state = resumeLanternWarmup(state, now)
	const verdicts: Array<LanternWarmupVerdict> = []
	for (let index = 0; index < 60; index++) {
		now += 16
		const step = stepLanternWarmup(state, now)
		state = step.state
		if (step.verdict !== 'wait') verdicts.push(step.verdict)
	}
	expect(verdicts).toEqual(['show'])
})
