import { expect, test } from 'vitest'
import {
	lanternCavity,
	lanternOrbRadius,
	lanternOrbRests,
} from './lantern-3d-layout.ts'
import {
	createLanternContents,
	createLanternSpin,
	dragLanternSpin,
	lanternFlickVelocity,
	lanternTiltLimit,
	stepLanternContents,
	stepLanternSpin,
	type LanternContents,
	type LanternContentsStep,
} from './lantern-3d-motion.ts'

const frame = 1 / 60

function restingContents() {
	return createLanternContents(
		lanternOrbRests.map((rest) => ({
			id: rest.id,
			x: rest.x,
			y: rest.y,
			z: rest.depth,
		})),
	)
}

function run(
	start: LanternContents,
	seconds: number,
	options: Omit<LanternContentsStep, 'time'>,
	startTime = 0,
	each?: (contents: LanternContents) => void,
) {
	let contents = start
	const frames = Math.round(seconds / frame)
	for (let index = 0; index < frames; index++) {
		contents = stepLanternContents(contents, frame, {
			...options,
			time: startTime + index * frame,
		})
		each?.(contents)
	}
	return contents
}

function expectInsideAndApart(contents: LanternContents) {
	for (const orb of contents.orbs) {
		const reach = Math.hypot(orb.x, orb.y, orb.z)
		expect(reach + orb.radius).toBeLessThanOrEqual(lanternCavity.radius + 1e-6)
		expect(orb.y + orb.radius).toBeLessThanOrEqual(lanternCavity.top + 1e-6)
		expect(orb.y - orb.radius).toBeGreaterThanOrEqual(
			lanternCavity.bottom - 1e-6,
		)
	}
	for (const [index, a] of contents.orbs.entries()) {
		for (const b of contents.orbs.slice(index + 1)) {
			const gap = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
			expect(gap).toBeGreaterThan(a.radius + b.radius - 0.02)
		}
	}
}

function awayFromHome(contents: LanternContents) {
	return Math.max(
		...contents.orbs.map((orb) =>
			Math.hypot(orb.x - orb.home.x, orb.y - orb.home.y, orb.z - orb.home.z),
		),
	)
}

test('orbs wander around their rests inside the glass and rest when motion stops', () => {
	const start = restingContents()
	expect(start.orbs.map((orb) => orb.id)).toEqual([
		'memory',
		'secrets',
		'packages',
		'triggers',
		'integrations',
		'apps',
	])
	expectInsideAndApart(start)

	let furthest = 0
	const wandered = run(
		start,
		20,
		{ amplitude: 1, spin: 0, tilt: 0 },
		0,
		(contents) => {
			expectInsideAndApart(contents)
			furthest = Math.max(furthest, awayFromHome(contents))
		},
	)
	expect(furthest).toBeGreaterThan(0.1)
	expect(furthest).toBeLessThan(0.6)
	expect(wandered.swirl).toBe(0)

	const rested = run(wandered, 12, { amplitude: 0, spin: 0, tilt: 0 })
	expect(awayFromHome(rested)).toBeLessThan(0.02)
	expect(rested.orbs.every((orb) => !orb.coasting)).toBe(true)
})

test('spinning the lantern swirls the orbs round, then they drift home', () => {
	const start = restingContents()
	const spun = run(
		start,
		1.5,
		{ amplitude: 0, spin: 6, tilt: 0 },
		0,
		(contents) => expectInsideAndApart(contents),
	)
	expect(spun.swirl).toBeGreaterThan(4)
	expect(spun.swirlAngle).toBeGreaterThan(2)
	expect(spun.orbs.every((orb) => orb.coasting)).toBe(true)
	expect(awayFromHome(spun)).toBeGreaterThan(0.4)
	// The fluid turns the same way as the lantern: +y spin moves the front to +x.
	const front = start.orbs.find((orb) => orb.id === 'triggers')!
	const carried = run(start, 0.25, { amplitude: 0, spin: 6, tilt: 0 })
	const after = carried.orbs.find((orb) => orb.id === 'triggers')!
	expect(after.x - front.x).toBeGreaterThan(0)

	const settled = run(
		spun,
		10,
		{ amplitude: 0, spin: 0, tilt: 0 },
		1.5,
		(contents) => expectInsideAndApart(contents),
	)
	expect(Math.abs(settled.swirl)).toBeLessThan(0.01)
	expect(settled.orbs.every((orb) => !orb.coasting)).toBe(true)
	expect(awayFromHome(settled)).toBeLessThan(0.05)
})

test('a held orb follows the pointer, a flick bounces off the glass, and it settles home', () => {
	const start = restingContents()
	const held = run(start, 0.5, {
		amplitude: 0,
		spin: 0,
		tilt: 0,
		hold: { id: 'apps', x: 0, y: -0.2, z: 0.1, vx: 0, vy: 0, vz: 0 },
	})
	const apps = held.orbs.find((orb) => orb.id === 'apps')!
	expect(apps).toMatchObject({ x: 0, y: -0.2, z: 0.1, coasting: true })
	expectInsideAndApart(held)

	// A pointer far past the glass pins the orb on the inside of the wall.
	const pinned = run(held, 0.1, {
		amplitude: 0,
		spin: 0,
		tilt: 0,
		hold: { id: 'apps', x: 5, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
	})
	const atWall = pinned.orbs.find((orb) => orb.id === 'apps')!
	expect(atWall.x + atWall.radius).toBeCloseTo(lanternCavity.radius - 0.017, 6)

	const tossed = stepLanternContents(held, frame, {
		time: 0,
		amplitude: 0,
		spin: 0,
		tilt: 0,
		hold: { id: 'apps', x: 0, y: -0.2, z: 0.1, vx: 4, vy: 0, vz: 0 },
	})
	let bounced = false
	const settled = run(
		tossed,
		8,
		{ amplitude: 0, spin: 0, tilt: 0 },
		0,
		(contents) => {
			expectInsideAndApart(contents)
			const orb = contents.orbs.find((entry) => entry.id === 'apps')!
			if (orb.vx < -0.5) bounced = true
		},
	)
	expect(bounced).toBe(true)
	expect(settled.orbs.every((orb) => !orb.coasting)).toBe(true)
	expect(awayFromHome(settled)).toBeLessThan(0.05)
})

test('the open orb comes forward to the lure and goes back when released', () => {
	const start = restingContents()
	const memory = start.orbs.find((orb) => orb.id === 'memory')!
	const lure = {
		id: 'memory' as const,
		x: memory.x,
		y: memory.y,
		z: memory.z + 0.4,
	}
	const forward = run(start, 1.2, { amplitude: 0, spin: 0, tilt: 0, lure })
	const lured = forward.orbs.find((orb) => orb.id === 'memory')!
	expect(
		Math.hypot(lured.x - lure.x, lured.y - lure.y, lured.z - lure.z),
	).toBeLessThan(0.03)
	expectInsideAndApart(forward)

	const back = run(forward, 8, { amplitude: 0, spin: 0, tilt: 0 })
	expect(awayFromHome(back)).toBeLessThan(0.02)
})

test('tilting the lantern tips the cap and base band the orbs stay under', () => {
	const tilt = lanternTiltLimit.max
	const tilted = run(restingContents(), 2, {
		amplitude: 0,
		spin: 0,
		tilt,
		hold: { id: 'memory', x: 0, y: 2, z: 0, vx: 0, vy: 0, vz: 0 },
	})
	const memory = tilted.orbs.find((orb) => orb.id === 'memory')!
	const height = memory.y * Math.cos(tilt) + memory.z * Math.sin(tilt)
	expect(height + lanternOrbRadius).toBeCloseTo(lanternCavity.top - 0.017, 6)
	// The tipped cap pushes along its own normal, so the orb slides back
	// as well as down.
	expect(memory.z).toBeLessThan(-0.03)
})

test('flick velocity reads only the last 90ms of a drag', () => {
	const samples = [
		{ x: 0, y: 0, z: 0, t: 0 },
		{ x: 0.1, y: 0, z: 0, t: 100 },
		{ x: 0.2, y: 0.05, z: 0, t: 150 },
		{ x: 0.4, y: 0.1, z: 0, t: 190 },
	]
	const velocity = lanternFlickVelocity(samples, 190)
	expect(velocity.vx).toBeCloseTo(0.3 / 0.09, 6)
	expect(velocity.vy).toBeCloseTo(0.1 / 0.09, 6)
	expect(velocity.vz).toBe(0)
	expect(lanternFlickVelocity(samples, 400)).toEqual({ vx: 0, vy: 0, vz: 0 })
	const capped = lanternFlickVelocity(
		[
			{ x: 0, y: 0, z: 0, t: 0 },
			{ x: 10, y: 0, z: 0, t: 50 },
		],
		60,
		3,
	)
	expect(capped.vx).toBeCloseTo(3, 6)
})

test('a flicked lantern coasts, settles face-on, tips upright, and its handle swings', () => {
	let spin = { ...createLanternSpin(), yawVelocity: 9, tilt: 0.3 }
	let swungMost = 0
	let peakTiltVelocity = 0
	for (let index = 0; index < 60 * 10; index++) {
		spin = stepLanternSpin(spin, frame, { held: false, settle: true })
		swungMost = Math.max(swungMost, Math.abs(spin.swing))
		peakTiltVelocity = Math.max(peakTiltVelocity, Math.abs(spin.tiltVelocity))
	}
	expect(spin.yaw).toBeGreaterThan(Math.PI)
	expect(
		Math.abs(spin.yaw - Math.round(spin.yaw / Math.PI) * Math.PI),
	).toBeLessThan(0.005)
	expect(Math.abs(spin.yawVelocity)).toBeLessThan(0.01)
	expect(Math.abs(spin.tilt)).toBeLessThan(0.001)
	expect(peakTiltVelocity).toBeGreaterThan(0.5)
	expect(swungMost).toBeGreaterThan(0.05)
	expect(Math.abs(spin.swing)).toBeLessThan(0.005)

	// Without settling, a slow coast simply stops where it is.
	let coast = { ...createLanternSpin(), yawVelocity: 0.8 }
	for (let index = 0; index < 60 * 10; index++) {
		coast = stepLanternSpin(coast, frame, { held: false, settle: false })
	}
	expect(coast.yaw).toBeCloseTo(0.8 / 1.25, 1)
	expect(
		Math.abs(coast.yaw - Math.round(coast.yaw / Math.PI) * Math.PI),
	).toBeGreaterThan(0.3)
})

test('dragging turns the lantern freely and tilts it only so far', () => {
	let spin = createLanternSpin()
	for (let index = 0; index < 200; index++) {
		spin = dragLanternSpin(spin, { yaw: 0.05, tilt: 0.05 }, frame)
	}
	expect(spin.yaw).toBeCloseTo(10, 6)
	expect(spin.tilt).toBeLessThanOrEqual(lanternTiltLimit.max)
	expect(spin.tilt).toBeGreaterThan(lanternTiltLimit.max - 0.05)
	expect(spin.yawVelocity).toBeCloseTo(0.05 / frame, 3)

	const back = dragLanternSpin(spin, { yaw: 0, tilt: -0.2 }, frame)
	expect(back.tilt).toBeCloseTo(spin.tilt - 0.2, 6)
	const held = stepLanternSpin(back, frame, { held: true, settle: true })
	expect(held.yaw).toBe(back.yaw)
	expect(held.tilt).toBe(back.tilt)
})
