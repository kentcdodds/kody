import { expect, test } from 'vitest'
import { lanternView } from './landing-lantern-3d-engine.ts'
import {
	createLanternOrbBodies,
	createLanternOrbit,
	createLanternResolution,
	createLanternWarmup,
	holdLanternOrbit,
	kodyGaze,
	lanternFlickVelocity,
	lanternGlobeRadius,
	lanternIdleDelay,
	lanternIdleMoment,
	lanternOrbRadius,
	lanternOrbSettledPosition,
	lanternOrbsAtRest,
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
import {
	landingLeaderOrbExit,
	landingLeaderPath,
	landingPrimitiveIds,
	type LandingLeaderPoint,
} from '#universal/landing-lantern.ts'

const frame = 1 / 60

/** Under the cap and over the base plate in landing-lantern-3d.gss. */
const capUnderside = 0.695
const basePlate = -0.695

/** Kody and the flame on his head in landing-lantern-3d.gss, swept round
 *  the lantern's axis: from under his chin to the flame's tip, ears and
 *  all. */
const kodySweep = { bottom: -0.26, top: 0.32, radius: 0.2 }

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

/** Room between an orb and Kody; negative when they overlap. */
function roomFromKody(body: LanternOrbBody) {
	const { x, y, z } = body.position
	const spine = Math.min(kodySweep.top, Math.max(kodySweep.bottom, y))
	return (
		Math.hypot(x, y - spine, z) -
		kodySweep.radius -
		lanternOrbRadius * body.scale
	)
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

/** The desktop stage in styles.css: the lantern at its 18rem column, the
 *  word list centered beside it, one 1.32rem word per 1.5 lines with
 *  0.55rem between. Words land on the left edge of their dots. */
function desktopStage(gap: number) {
	const width = 288
	const height = (width * 1242) / 863
	const row = 1.32 * 16 * 1.5
	const between = 0.55 * 16
	const top = (height - (6 * row + 5 * between)) / 2
	return {
		view: {
			left: width * lanternView.left,
			top: height * lanternView.top,
			width: width * lanternView.size,
			height: height * lanternView.size,
		},
		words: landingPrimitiveIds.map((_, index) => ({
			x: width + gap - 2,
			y: top + row / 2 + index * (row + between),
		})),
	}
}

/** Points along a leader, from the path the page draws. */
function leaderPoints(from: LandingLeaderPoint, to: LandingLeaderPoint) {
	const [x0, y0, x1, y1, x2, y2, x3, y3] = landingLeaderPath(from, to)
		.match(/-?\d+(\.\d+)?/g)!
		.map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	]
	return Array.from({ length: 25 }, (_, index) => {
		const t = index / 24
		const u = 1 - t
		const a = u * u * u
		const b = 3 * u * u * t
		const c = 3 * u * t * t
		const d = t * t * t
		return {
			x: a * x0 + b * x1 + c * x2 + d * x3,
			y: a * y0 + b * y1 + c * y2 + d * y3,
		}
	})
}

function segmentsCross(
	a: LandingLeaderPoint,
	b: LandingLeaderPoint,
	c: LandingLeaderPoint,
	d: LandingLeaderPoint,
) {
	const side = (
		p: LandingLeaderPoint,
		q: LandingLeaderPoint,
		r: LandingLeaderPoint,
	) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
	return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0
}

function leadersCross(
	a: ReadonlyArray<LandingLeaderPoint>,
	b: ReadonlyArray<LandingLeaderPoint>,
) {
	const span = (points: ReadonlyArray<LandingLeaderPoint>) => ({
		top: Math.min(...points.map((point) => point.y)),
		bottom: Math.max(...points.map((point) => point.y)),
	})
	const spanA = span(a)
	const spanB = span(b)
	if (spanA.bottom < spanB.top || spanB.bottom < spanA.top) return false
	for (let i = 0; i < a.length - 1; i++) {
		for (let j = 0; j < b.length - 1; j++) {
			if (segmentsCross(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!)) return true
		}
	}
	return false
}

/** The pairs of leaders the page would draw crossing, with the lantern
 *  turned to `yaw`. */
function crossingLeaders(
	stage: ReturnType<typeof desktopStage>,
	bodies: ReadonlyArray<LanternOrbBody>,
	yaw: number,
	scale = 1,
) {
	const basis = lanternViewBasis()
	const leaders = bodies.map((body, index) => {
		const world = localToWorld(body.position, yaw)
		const point = projectLanternPoint(basis, world, stage.view)
		const radius = projectedSphereRadius(
			basis,
			world,
			lanternOrbRadius * scale,
			stage.view.height,
		)
		const centre = {
			x: stage.view.left + point.x,
			y: stage.view.top + point.y,
		}
		const to = stage.words[index]!
		return leaderPoints(landingLeaderOrbExit(centre, to, radius), to)
	})
	const pairs: Array<string> = []
	for (let i = 0; i < leaders.length; i++) {
		for (let j = i + 1; j < leaders.length; j++) {
			if (!leadersCross(leaders[i]!, leaders[j]!)) continue
			pairs.push(`${bodies[i]!.id} and ${bodies[j]!.id}`)
		}
	}
	return pairs
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
	// Dragging right turns the lantern the same way the bail turns in GSS:
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

test('leaders to the word list never cross, whichever way the lantern turns', () => {
	const drift: Array<Array<LanternOrbBody>> = []
	let bodies = createLanternOrbBodies()
	for (let step = 0; step < 60 / frame; step++) {
		bodies = stepLanternOrbs(bodies, frame, {
			time: step * frame,
			amplitude: 1,
		})
		if (step % 90 === 0) drift.push(bodies)
	}
	const crossings: Array<string> = []
	// The narrowest and widest desktop gaps, with the orbs at rest and as
	// big as hover makes them.
	for (const gap of [56, 96]) {
		const stage = desktopStage(gap)
		for (const scale of [1, 1.18]) {
			for (const orbs of drift) {
				for (let degree = 0; degree < 360; degree += 3) {
					const yaw = (degree * Math.PI) / 180
					for (const pair of crossingLeaders(stage, orbs, yaw, scale)) {
						crossings.push(
							`${pair} at ${degree}deg, gap ${gap}, scale ${scale}`,
						)
					}
				}
			}
		}
	}
	expect(crossings).toEqual([])
})

test('a turn or a tap swirls the orbs round together, so leaders never cross', () => {
	const stages = [desktopStage(56), desktopStage(96)]
	const crossings: Array<string> = []
	let widest = 0
	/** The engine's frame: the orbit, then the orbs, lagging its turn. */
	const watch = (
		label: string,
		start: { orbit: LanternOrbit; bodies: Array<LanternOrbBody> },
		seconds: number,
	) => {
		let { orbit, bodies } = start
		let poseYaw = lanternPose(orbit, 0).yaw
		for (let time = frame; time < seconds; time += frame) {
			orbit = stepLanternOrbit(orbit, frame, { held: false, motion: true })
			const yaw = lanternPose(orbit, time).yaw
			bodies = stepLanternOrbs(bodies, frame, {
				time,
				amplitude: 1,
				spin: yaw - poseYaw,
			})
			poseYaw = yaw
			widest = Math.max(widest, Math.abs(bodies[0]!.swirl))
			for (const stage of stages) {
				for (const pair of crossingLeaders(stage, bodies, yaw)) {
					crossings.push(`${label}: ${pair} at ${time.toFixed(2)} s`)
				}
			}
		}
		return bodies
	}
	const homes = createLanternOrbBodies()
	const expectHome = (bodies: ReadonlyArray<LanternOrbBody>) => {
		expect(Math.abs(bodies[0]!.swirl)).toBeLessThan(0.02)
		for (const body of bodies) {
			const home = homes.find((entry) => entry.id === body.id)!
			expect(distance(body.position, home.position)).toBeLessThan(0.1)
		}
	}

	// A flick at the engine's top spin, each way: the orbs lag behind, then
	// swirl back.
	for (const yawVelocity of [-9, 9]) {
		const orbit = { ...holdLanternOrbit(createLanternOrbit(), 0), yawVelocity }
		expectHome(watch(`flick ${yawVelocity}`, { orbit, bodies: homes }, 4))
	}
	expect(widest).toBeGreaterThan((30 * Math.PI) / 180)

	// The word list and keyboard focus turn each orb to the front, from the
	// far side.
	for (const body of homes) {
		const far = { ...createLanternOrbit(), yaw: Math.PI }
		const orbit = turnLanternTo(far, 0, body.position)
		expectHome(watch(`turn to ${body.id}`, { orbit, bodies: homes }, 3))
	}

	// A tap sets every orb swirling, one way or the other.
	for (const roll of [0.2, 0.8]) {
		widest = 0
		const bodies = pokeLanternOrbs(homes, () => roll)
		expect(
			bodies.every((body) => body.swirlSpeed === bodies[0]!.swirlSpeed),
		).toBe(true)
		expectHome(
			watch(`tap ${roll}`, { orbit: createLanternOrbit(), bodies }, 3.5),
		)
		expect(widest).toBeGreaterThan((15 * Math.PI) / 180)
	}
	expect(crossings).toEqual([])
})

test('the sway leaves the orbs at rest, and a tap is busy until its swirl dies', () => {
	let orbit = createLanternOrbit()
	let poseYaw = lanternPose(orbit, 0).yaw
	let time = 0
	let untapped = createLanternOrbBodies()
	let tapped: Array<LanternOrbBody> = []
	const step = () => {
		time += frame
		orbit = stepLanternOrbit(orbit, frame, { held: false, motion: true })
		const yaw = lanternPose(orbit, time).yaw
		const options = { time, amplitude: 1, spin: yaw - poseYaw }
		untapped = stepLanternOrbs(untapped, frame, options)
		if (tapped.length > 0) tapped = stepLanternOrbs(tapped, frame, options)
		poseYaw = yaw
	}

	// Kody's idle moment and hover both wait for the orbs to rest, so the
	// sway alone must not keep them busy.
	let busy = 0
	while (time < 60) {
		step()
		if (!lanternOrbsAtRest(untapped)) busy++
	}
	expect(busy).toBe(0)

	tapped = pokeLanternOrbs(untapped, () => 0.8)
	expect(lanternOrbsAtRest(tapped)).toBe(false)
	const tappedAt = time
	let apart = 0
	let settledApart = 0
	while (!lanternOrbsAtRest(tapped) && time < tappedAt + 5) {
		step()
		for (const [index, body] of tapped.entries()) {
			const twin = untapped[index]!
			apart = Math.max(apart, distance(body.position, twin.position))
			settledApart = Math.max(
				settledApart,
				distance(
					lanternOrbSettledPosition(body),
					lanternOrbSettledPosition(twin),
				),
			)
		}
	}
	expect(time - tappedAt).toBeGreaterThan(0.5)
	expect(time - tappedAt).toBeLessThan(2.5)
	// The swirl carries the orbs well round, yet once it is gone each is
	// where it would have been without the tap, which is where the word
	// list turns the lantern to.
	expect(apart).toBeGreaterThan(0.15)
	expect(settledApart).toBeLessThan(1e-6)
})

test('orbs keep out of Kody, even thrown straight at him', () => {
	let bodies = createLanternOrbBodies()
	for (const body of bodies) expect(roomFromKody(body)).toBeGreaterThan(0)

	for (const id of landingPrimitiveIds) {
		const { x, y, z } = bodies.find((body) => body.id === id)!.position
		const size = Math.hypot(x, y, z)
		bodies = stepLanternOrbs(bodies, 0, {
			time: 0,
			amplitude: 1,
			hold: {
				id,
				position: { x, y, z },
				velocity: {
					x: (-x / size) * 4,
					y: (-y / size) * 4,
					z: (-z / size) * 4,
				},
			},
		})
		for (let t = 0; t < 2; t += frame) {
			bodies = stepLanternOrbs(bodies, frame, { time: t, amplitude: 1 })
			expectInsideLantern(bodies)
			for (const body of bodies) expect(roomFromKody(body)).toBeGreaterThan(0)
		}
	}

	// Dragged onto him from over the flame, under his chin, or head on, an
	// orb stops beside him, still inside the glass.
	for (const position of [
		{ x: 0, y: 0.6, z: 0 },
		{ x: 0.02, y: -0.6, z: 0 },
		{ x: 0, y: -0.1, z: 0.05 },
	]) {
		bodies = stepLanternOrbs(bodies, frame, {
			time: 0,
			amplitude: 1,
			hold: { id: 'memory', position, velocity: { x: 0, y: 0, z: 0 } },
		})
		expectInsideLantern(bodies)
		for (const body of bodies) expect(roomFromKody(body)).toBeGreaterThan(0)
	}
})

test('a tossed orb bounces, knocks the others, and they are soon home in order', () => {
	let bodies = createLanternOrbBodies()
	const orb = (id: string) => bodies.find((body) => body.id === id)!
	// Thrown straight at the glass, an orb comes back off it.
	bodies = stepLanternOrbs(bodies, 0, {
		time: 0,
		amplitude: 1,
		hold: {
			id: 'packages',
			position: orb('packages').position,
			velocity: { x: 4, y: 0, z: 0 },
		},
	})
	let bounced = false
	for (let t = frame; t < 0.5 && !bounced; t += frame) {
		bodies = stepLanternOrbs(bodies, frame, { time: t, amplitude: 1 })
		expectInsideLantern(bodies)
		bounced = orb('packages').velocity.x < -1
	}
	expect(bounced).toBe(true)

	bodies = createLanternOrbBodies()
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
	expect(orb('memory').position.x).toBeGreaterThan(0.5)

	// Released mid-flick, as the engine does on pointerup.
	bodies = stepLanternOrbs(bodies, 0, {
		time: 0,
		amplitude: 1,
		hold: {
			id: 'memory',
			position: orb('memory').position,
			velocity: { x: -4, y: 0.4, z: 0 },
		},
	})
	expect(orb('memory').coasting).toBe(true)
	const stage = desktopStage(56)
	const knocked = new Set<string>()
	let lastCrossing = 0
	let settledAt: number | null = null
	for (let t = frame; t < 8; t += frame) {
		bodies = stepLanternOrbs(bodies, frame, { time: t, amplitude: 1 })
		expectInsideLantern(bodies)
		for (const body of bodies) {
			if (body.id !== 'memory' && body.coasting) knocked.add(body.id)
		}
		if (crossingLeaders(stage, bodies, 0).length > 0) lastCrossing = t
		if (settledAt === null && bodies.every((body) => !body.coasting)) {
			settledAt = t
		}
	}
	expect(knocked.size).toBeGreaterThan(0)
	// Its leader crosses the others while it flies, but every orb is drawn
	// home: in order again within two seconds, and back in the drift soon
	// after.
	expect(lastCrossing).toBeLessThan(2)
	expect(settledAt).not.toBeNull()
	expect(settledAt!).toBeLessThan(4)
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

test('Kody counts his marbles after ten quiet seconds, then only now and then', () => {
	expect(lanternIdleMoment(0)).toBeNull()
	expect(lanternIdleMoment(lanternIdleDelay - 0.05)).toBeNull()
	const start = lanternIdleMoment(lanternIdleDelay)!
	expect(start.gaze).toBe(0)
	expect(Object.values(start.pop).every((pop) => pop === 0)).toBe(true)

	// Each marble pops once, in the order of the word list, with his eyes on it.
	const peaks = landingPrimitiveIds.map((id) => {
		let peak = { t: 0, pop: 0 }
		for (let t = 0; t < 4; t += 0.01) {
			const pop = lanternIdleMoment(lanternIdleDelay + t)?.pop[id] ?? 0
			if (pop > peak.pop) peak = { t, pop }
		}
		return peak
	})
	peaks.forEach((peak, index) => {
		expect(peak.pop).toBeGreaterThan(0.99)
		if (index > 0) expect(peak.t).toBeGreaterThan(peaks[index - 1]!.t)
		const moment = lanternIdleMoment(lanternIdleDelay + peak.t)!
		expect(moment.gaze).toBeGreaterThan(0.9)
		expect(moment.focus).toBeGreaterThanOrEqual(index - 0.01)
		expect(moment.focus).toBeLessThan(index + 0.5)
	})

	// Then a nod as the flame flares, and everything is back at rest
	// before the moment ends.
	const last = peaks.at(-1)!.t
	const after = (
		pick: (moment: NonNullable<ReturnType<typeof lanternIdleMoment>>) => number,
	) => {
		let best = { t: 0, value: 0 }
		for (let t = last; t < 4; t += 0.01) {
			const moment = lanternIdleMoment(lanternIdleDelay + t)
			const value = moment ? pick(moment) : 0
			if (value > best.value) best = { t, value }
		}
		return best
	}
	expect(after((moment) => moment.bow).value).toBeGreaterThan(0.99)
	expect(after((moment) => moment.flare).value).toBeGreaterThan(0.99)
	const ending = lanternIdleMoment(lanternIdleDelay + 3.79)!
	expect(ending.gaze).toBe(0)
	expect(ending.bow).toBe(0)
	expect(ending.flare).toBe(0)
	expect(Object.values(ending.pop).every((pop) => pop === 0)).toBe(true)
	expect(lanternIdleMoment(lanternIdleDelay + 3.85)).toBeNull()

	// The page stays calm for a long while, then he counts again.
	for (let t = 4; t < 40; t += 0.25) {
		expect(lanternIdleMoment(lanternIdleDelay + t)).toBeNull()
	}
	expect(lanternIdleMoment(lanternIdleDelay + 40.7)?.pop.memory).toBeCloseTo(
		1,
		6,
	)
})

test('Kody turns to look at a marble but never turns his back', () => {
	const lookLimit = (32 * Math.PI) / 180
	const nodLimit = (20 * Math.PI) / 180
	// Right and up are positive, as rotate-y and rotate-x turn #kody in GSS.
	const right = kodyGaze({ x: 0.4, y: -0.14, z: 0.3 })
	expect(right.look).toBeGreaterThan(0.3)
	expect(right.nod).toBeCloseTo(0, 9)
	const above = kodyGaze({ x: 0, y: 0.3, z: 0.3 })
	expect(above.look).toBeCloseTo(0, 9)
	expect(above.nod).toBeGreaterThan(0.3)
	expect(kodyGaze({ x: 0, y: -0.5, z: 0.4 }).nod).toBeLessThan(0)

	// Behind him, he glances over his shoulder instead.
	const behind = kodyGaze({ x: -0.5, y: 0.45, z: -0.45 })
	expect(behind.look).toBeLessThan(0)
	for (const body of [
		{ position: { x: -0.5, y: 0.45, z: -0.45 } },
		...createLanternOrbBodies(),
	]) {
		const gaze = kodyGaze(body.position)
		expect(Math.abs(gaze.look)).toBeLessThanOrEqual(lookLimit)
		expect(Math.abs(gaze.nod)).toBeLessThanOrEqual(nodLimit)
	}
})
