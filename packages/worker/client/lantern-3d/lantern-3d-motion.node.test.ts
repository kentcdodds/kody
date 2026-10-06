import { expect, test } from 'vitest'
import {
	lanternCavity,
	lanternOrbHomes,
	lanternOrbRadius,
} from './lantern-3d-layout.ts'
import {
	createLanternContents,
	createLanternSpin,
	dragLanternSpin,
	lanternFlickVelocity,
	lanternFluidToRoot,
	lanternRootToFluid,
	lanternTiltLimit,
	stepLanternContents,
	stepLanternSpin,
	type LanternContents,
	type LanternContentsStep,
} from './lantern-3d-motion.ts'

const frame = 1 / 60

const still = { amplitude: 0, yaw: 0, tilt: 0 } as const

function run(
	start: LanternContents,
	seconds: number,
	options: Omit<LanternContentsStep, 'time'>,
	startTime = 0,
	each?: (contents: LanternContents, time: number) => void,
) {
	let contents = start
	const frames = Math.round(seconds / frame)
	for (let index = 0; index < frames; index++) {
		const time = startTime + index * frame
		contents = stepLanternContents(contents, frame, { ...options, time })
		each?.(contents, time)
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

/** Smallest gap between two orbs' discs seen face-on. */
function faceOnClearance(contents: LanternContents) {
	let least = Infinity
	for (const [index, a] of contents.orbs.entries()) {
		for (const b of contents.orbs.slice(index + 1)) {
			const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius
			least = Math.min(least, gap)
		}
	}
	return least
}

test('orbs rest in word order, top to bottom, with none overlapping face-on', () => {
	const start = createLanternContents(lanternOrbHomes)
	expect(start.orbs.map((orb) => orb.id)).toEqual([
		'memory',
		'secrets',
		'packages',
		'triggers',
		'integrations',
		'apps',
	])
	const heights = start.orbs.map((orb) => orb.y)
	expect(heights).toEqual([...heights].sort((a, b) => b - a))
	expect(faceOnClearance(start)).toBeGreaterThan(0.05)
	// Real depth: some sit in front of the axis and some behind it.
	const depths = start.orbs.map((orb) => orb.z)
	expect(Math.max(...depths) - Math.min(...depths)).toBeGreaterThan(0.45)
	expectInsideAndApart(start)
})

test('the wander keeps every orb near home, in order, and apart', () => {
	let furthest = 0
	const wandered = run(
		createLanternContents(lanternOrbHomes),
		30,
		{ ...still, amplitude: 1 },
		0,
		(contents) => {
			expectInsideAndApart(contents)
			expect(faceOnClearance(contents)).toBeGreaterThan(0)
			const heights = contents.orbs.map((orb) => orb.y)
			expect(heights).toEqual([...heights].sort((a, b) => b - a))
			furthest = Math.max(furthest, awayFromHome(contents))
		},
	)
	expect(furthest).toBeGreaterThan(0.04)
	expect(furthest).toBeLessThan(0.2)
	expect(wandered.swirl).toBe(0)

	const rested = run(wandered, 12, still)
	expect(awayFromHome(rested)).toBeLessThan(0.02)
	expect(rested.orbs.every((orb) => !orb.coasting)).toBe(true)
})

test('the fluid trails a turn, sloshes past, and settles where the lantern stops', () => {
	let contents = createLanternContents(lanternOrbHomes)
	let trailed = 0
	let time = 0
	// A flick: the lantern turns fast, slows, and stops a half turn round.
	for (let index = 0; index < 60 * 1.5; index++) {
		const yaw = Math.PI * (1 - Math.exp(-3 * time))
		contents = stepLanternContents(contents, frame, { ...still, yaw, time })
		trailed = Math.max(trailed, yaw - contents.swirlAngle)
		time += frame
	}
	expect(trailed).toBeGreaterThan(0.4)
	let overshot = 0
	contents = run(contents, 6, { ...still, yaw: Math.PI }, time, (next) => {
		overshot = Math.max(overshot, next.swirlAngle - Math.PI)
		expectInsideAndApart(next)
	})
	expect(overshot).toBeGreaterThan(0.005)
	expect(Math.abs(contents.swirlAngle - Math.PI)).toBeLessThan(0.002)
	expect(Math.abs(contents.swirl)).toBeLessThan(0.01)
	// Carried rigidly, the orbs never left home in the fluid's frame.
	expect(awayFromHome(contents)).toBeLessThan(0.01)

	// Without the trail, the fluid turns with the lantern at once.
	const rigid = stepLanternContents(contents, 0, {
		...still,
		yaw: Math.PI / 4,
		rigid: true,
		time,
	})
	expect(rigid.swirlAngle).toBe(Math.PI / 4)
	expect(rigid.swirl).toBe(0)
})

test('turning the fluid moves the front of the globe to the right', () => {
	const front = { x: 0, y: 0, z: 0.5 }
	const turned = lanternFluidToRoot(front, 0.3, 0)
	expect(turned.x).toBeGreaterThan(0.1)
	// A positive tilt tips the top toward the camera.
	const top = lanternFluidToRoot({ x: 0, y: 0.5, z: 0 }, 0, 0.3)
	expect(top.z).toBeGreaterThan(0.1)

	const point = { x: 0.31, y: -0.42, z: 0.18 }
	const back = lanternRootToFluid(
		lanternFluidToRoot(point, 2.1, -0.27),
		2.1,
		-0.27,
	)
	expect(back.x).toBeCloseTo(point.x, 9)
	expect(back.y).toBeCloseTo(point.y, 9)
	expect(back.z).toBeCloseTo(point.z, 9)
})

test('a held orb follows the pointer, a flick bounces off the glass, and it settles home', () => {
	const start = createLanternContents(lanternOrbHomes)
	const held = run(start, 0.5, {
		...still,
		hold: { id: 'apps', x: 0, y: -0.2, z: 0.1, vx: 0, vy: 0, vz: 0 },
	})
	const apps = held.orbs.find((orb) => orb.id === 'apps')!
	expect(apps).toMatchObject({ x: 0, y: -0.2, z: 0.1, coasting: true })
	expectInsideAndApart(held)

	// A pointer far past the glass pins the orb on the inside of the wall.
	const pinned = run(held, 0.1, {
		...still,
		hold: { id: 'apps', x: 5, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
	})
	const atWall = pinned.orbs.find((orb) => orb.id === 'apps')!
	expect(atWall.x + atWall.radius).toBeCloseTo(lanternCavity.radius - 0.017, 6)

	const tossed = stepLanternContents(held, frame, {
		...still,
		time: 0,
		hold: { id: 'apps', x: 0, y: -0.2, z: 0.1, vx: 4, vy: 0, vz: 0 },
	})
	let bounced = false
	const settled = run(tossed, 12, still, 0, (contents) => {
		expectInsideAndApart(contents)
		const orb = contents.orbs.find((entry) => entry.id === 'apps')!
		if (orb.vx < -0.5) bounced = true
	})
	expect(bounced).toBe(true)
	expect(settled.orbs.every((orb) => !orb.coasting)).toBe(true)
	expect(awayFromHome(settled)).toBeLessThan(0.05)
})

test('a hold on a turned lantern lands where the pointer is', () => {
	const turned = run(createLanternContents(lanternOrbHomes), 0.1, {
		...still,
		yaw: 1.2,
		rigid: true,
	})
	const pointer = { x: 0.2, y: 0.1, z: 0.3 }
	const held = stepLanternContents(turned, frame, {
		...still,
		yaw: 1.2,
		rigid: true,
		time: 0,
		hold: { id: 'secrets', ...pointer, vx: 0, vy: 0, vz: 0 },
	})
	const secrets = held.orbs.find((orb) => orb.id === 'secrets')!
	const shown = lanternFluidToRoot(secrets, held.swirlAngle, 0)
	expect(shown.x).toBeCloseTo(pointer.x, 6)
	expect(shown.y).toBeCloseTo(pointer.y, 6)
	expect(shown.z).toBeCloseTo(pointer.z, 6)
})

test('the open orb comes forward to the lure and goes back when released', () => {
	const start = createLanternContents(lanternOrbHomes)
	const memory = start.orbs.find((orb) => orb.id === 'memory')!
	const lure = {
		id: 'memory' as const,
		x: memory.x,
		y: memory.y,
		z: memory.z + 0.4,
	}
	const forward = run(start, 1.2, { ...still, lure })
	const lured = forward.orbs.find((orb) => orb.id === 'memory')!
	expect(
		Math.hypot(lured.x - lure.x, lured.y - lure.y, lured.z - lure.z),
	).toBeLessThan(0.03)
	expectInsideAndApart(forward)

	const back = run(forward, 8, still)
	expect(awayFromHome(back)).toBeLessThan(0.02)
})

test('the fluid tips with the glass, so the cap stays over a held orb', () => {
	const tilt = lanternTiltLimit.max
	const tilted = run(createLanternContents(lanternOrbHomes), 2, {
		...still,
		tilt,
		hold: { id: 'memory', x: 0, y: 2, z: 0, vx: 0, vy: 0, vz: 0 },
	})
	const memory = tilted.orbs.find((orb) => orb.id === 'memory')!
	expect(memory.y + lanternOrbRadius).toBeCloseTo(lanternCavity.top - 0.017, 6)
	const shown = lanternFluidToRoot(memory, tilted.swirlAngle, tilt)
	const height = shown.y * Math.cos(tilt) + shown.z * Math.sin(tilt)
	expect(height + lanternOrbRadius).toBeCloseTo(lanternCavity.top - 0.017, 6)
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
