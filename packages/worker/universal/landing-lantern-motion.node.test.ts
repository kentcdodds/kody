import { expect, test } from 'vitest'
import { landingLanternImage, landingLanternOrbs } from './landing-lantern.ts'
import {
	clampToCavity,
	createLanternOrbBodies,
	landingLanternAperture,
	landingLanternCavity,
	lanternFlickVelocity,
	stepLanternOrbMotion,
	type LanternOrbBody,
} from './landing-lantern-motion.ts'

const lanternAspect = landingLanternImage.height / landingLanternImage.width

function insideAperture(body: { y: number; radius: number }) {
	const top = landingLanternAperture.top * lanternAspect + body.radius + 0.008
	const bottom =
		landingLanternAperture.bottom * lanternAspect - body.radius - 0.008
	return body.y >= top - 1e-6 && body.y <= bottom + 1e-6
}

function simulate(seconds: number, amplitude: number) {
	let bodies = createLanternOrbBodies()
	const dt = 1 / 60
	let wallTouches = 0
	let pairTouches = 0
	let maxSpeed = 0
	let maxTravel = 0
	const homes = createLanternOrbBodies()
	for (let step = 0; step < seconds * 60; step++) {
		bodies = stepLanternOrbMotion(bodies, dt, {
			time: step * dt,
			amplitude,
		})
		for (const body of bodies) {
			const home = homes.find((entry) => entry.id === body.id)!
			maxTravel = Math.max(
				maxTravel,
				Math.hypot(body.x - home.x, body.y - home.y),
			)
		}
		for (const body of bodies) {
			maxSpeed = Math.max(maxSpeed, Math.hypot(body.vx, body.vy))
			const fromCentre = Math.hypot(
				body.x - landingLanternCavity.x,
				body.y - landingLanternCavity.y,
			)
			const limit = landingLanternCavity.r - body.radius - 0.008
			expect(fromCentre).toBeLessThanOrEqual(limit + 1e-6)
			const top =
				landingLanternAperture.top * lanternAspect + body.radius + 0.008
			const bottom =
				landingLanternAperture.bottom * lanternAspect - body.radius - 0.008
			// The lid and base are the walls the cluster actually meets. The
			// circle is still a bound, just further out at the poles.
			if (
				limit - fromCentre < 0.01 ||
				body.y - top < 0.01 ||
				bottom - body.y < 0.01
			) {
				wallTouches++
			}
			expect(insideAperture(body)).toBe(true)
			expect(body.coasting).toBe(false)
		}
		for (let i = 0; i < bodies.length; i++) {
			for (let j = i + 1; j < bodies.length; j++) {
				const a = bodies[i]!
				const b = bodies[j]!
				const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius
				expect(gap).toBeGreaterThan(-0.02)
				if (gap < 0.008) pairTouches++
			}
		}
	}
	return { bodies, wallTouches, pairTouches, maxSpeed, maxTravel }
}

test('orb motion floats slowly inside the glass and bumps instead of bouncing', () => {
	const rested = createLanternOrbBodies()
	expect(rested.map((body) => body.id)).toEqual(
		landingLanternOrbs.map((orb) => orb.id),
	)
	for (const body of rested) {
		expect(body.vx).toBe(0)
		expect(body.vy).toBe(0)
	}

	const held = stepLanternOrbMotion(rested, 1 / 60, {
		time: 2,
		amplitude: 0,
	})
	for (const [index, body] of held.entries()) {
		expect(body.x).toBeCloseTo(rested[index]!.x, 6)
		expect(body.y).toBeCloseTo(rested[index]!.y, 6)
	}
	const started = createLanternOrbBodies()
	const startedX = started[0]!.x
	stepLanternOrbMotion(started, 1 / 60, { time: 1, amplitude: 1 })
	expect(started[0]!.x).toBe(startedX)

	const full = simulate(40, 1)
	const quiet = simulate(40, 0.62)
	expect(full.maxSpeed).toBeLessThan(0.05)
	expect(quiet.maxSpeed).toBeLessThanOrEqual(full.maxSpeed + 1e-6)
	expect(full.wallTouches).toBeGreaterThan(0)
	expect(full.pairTouches).toBeGreaterThan(0)
	expect(full.maxTravel).toBeGreaterThan(0.02)
	expect(full.maxTravel).toBeLessThan(0.16)
	expect(quiet.maxTravel).toBeLessThan(full.maxTravel)

	const flung = structuredClone(rested) satisfies Array<LanternOrbBody>
	const one = flung[1]!
	one.x = landingLanternCavity.x + landingLanternCavity.r
	one.y = landingLanternCavity.y
	one.vx = 0.4
	one.vy = 0
	const stopped = stepLanternOrbMotion(flung, 1 / 60, {
		time: 0,
		amplitude: 0,
	})
	const after = stopped[1]!
	const nx = after.x - landingLanternCavity.x
	const ny = after.y - landingLanternCavity.y
	const outward = (after.vx * nx + after.vy * ny) / Math.hypot(nx, ny)
	expect(outward).toBeLessThan(0.02)
	expect(clampToCavity(2, 2, 0.1).x).toBeLessThan(landingLanternCavity.x + 1)
	const raised = structuredClone(rested) satisfies Array<LanternOrbBody>
	const memory = raised[0]!
	memory.y = 0.05
	memory.vy = -0.2
	const heldDown = stepLanternOrbMotion(raised, 1 / 60, {
		time: 0,
		amplitude: 0,
	})
	expect(insideAperture(heldDown[0]!)).toBe(true)
	expect(heldDown[0]!.vy).toBeGreaterThanOrEqual(0)

	const pair = structuredClone(rested) satisfies Array<LanternOrbBody>
	const left = pair[0]!
	const right = pair[2]!
	left.x = landingLanternCavity.x - 0.04
	left.y = landingLanternCavity.y
	right.x = landingLanternCavity.x + 0.04
	right.y = landingLanternCavity.y
	left.homeX = left.x
	left.homeY = left.y
	right.homeX = right.x
	right.homeY = right.y
	left.vx = 0.04
	right.vx = -0.04
	const met = stepLanternOrbMotion(pair, 1 / 60, { time: 0, amplitude: 0 })
	const rel = met[0]!.vx - met[2]!.vx
	expect(rel).toBeGreaterThan(-0.01)
	expect(rel).toBeLessThan(0.02)
})

test('a grab flicks an orb into the glass and into the other orbs', () => {
	const rested = createLanternOrbBodies()
	const memory = rested.find((body) => body.id === 'memory')!
	const homeX = memory.x
	const held = stepLanternOrbMotion(rested, 1 / 60, {
		time: 1,
		amplitude: 1,
		hold: { id: 'memory', x: 0.5, y: landingLanternCavity.y, vx: 1.4, vy: 0 },
	})
	expect(rested.find((body) => body.id === 'memory')!.x).toBe(homeX)
	const grabbed = held.find((body) => body.id === 'memory')!
	expect(grabbed.coasting).toBe(true)
	expect(grabbed.x).toBeGreaterThan(0.45)
	expect(grabbed.x).toBeLessThan(0.55)
	expect(grabbed.vx).toBeCloseTo(1.4, 5)
	expect(insideAperture(grabbed)).toBe(true)

	const flick = lanternFlickVelocity(
		[
			{ x: 0.2, y: 0.7, t: 0 },
			{ x: 0.55, y: 0.7, t: 1020 },
			{ x: 0.7, y: 0.68, t: 1100 },
		],
		1100,
	)
	expect(flick.vx).toBeCloseTo(0.15 / 0.08, 5)
	expect(flick.vy).toBeCloseTo(-0.02 / 0.08, 5)
	expect(lanternFlickVelocity([{ x: 0, y: 0, t: 0 }], 10)).toEqual({
		vx: 0,
		vy: 0,
	})

	const tossed = structuredClone(rested) satisfies Array<LanternOrbBody>
	const flyer = tossed.find((body) => body.id === 'secrets')!
	flyer.x = landingLanternCavity.x
	flyer.y = landingLanternCavity.y
	flyer.vx = 1.5
	flyer.vy = 0
	flyer.coasting = true
	const coast = stepLanternOrbMotion(tossed, 1 / 60, {
		time: 0,
		amplitude: 0,
	})
	const coasted = coast.find((body) => body.id === 'secrets')!
	expect(coasted.x).toBeGreaterThan(flyer.x + 0.01)
	expect(coasted.coasting).toBe(true)

	const againstGlass = structuredClone(rested) satisfies Array<LanternOrbBody>
	const wall = againstGlass.find((body) => body.id === 'packages')!
	wall.x = landingLanternCavity.x + landingLanternCavity.r
	wall.y = landingLanternCavity.y
	wall.vx = 1.2
	wall.vy = 0
	wall.coasting = true
	const bounced = stepLanternOrbMotion(againstGlass, 1 / 60, {
		time: 0,
		amplitude: 0,
	}).find((body) => body.id === 'packages')!
	expect(bounced.vx).toBeLessThan(0)
	expect(insideAperture(bounced)).toBe(true)

	const pair = structuredClone(rested) satisfies Array<LanternOrbBody>
	const left = pair.find((body) => body.id === 'triggers')!
	const right = pair.find((body) => body.id === 'integrations')!
	left.x = landingLanternCavity.x - 0.05
	left.y = landingLanternCavity.y
	right.x = landingLanternCavity.x + 0.05
	right.y = landingLanternCavity.y
	left.vx = 1.1
	left.vy = 0
	left.coasting = true
	right.vx = 0
	right.vy = 0
	const knocked = stepLanternOrbMotion(pair, 1 / 60, {
		time: 0,
		amplitude: 0,
	})
	const knockedRight = knocked.find((body) => body.id === 'integrations')!
	const knockedLeft = knocked.find((body) => body.id === 'triggers')!
	expect(knockedRight.vx).toBeGreaterThan(0.3)
	expect(knockedRight.coasting).toBe(true)
	expect(knockedLeft.vx).toBeLessThan(left.vx)

	let bodies = structuredClone(rested) satisfies Array<LanternOrbBody>
	const apps = bodies.find((body) => body.id === 'apps')!
	apps.x = landingLanternCavity.x
	apps.y = landingLanternCavity.y
	apps.vx = 1.8
	apps.vy = -0.6
	apps.coasting = true
	let peakNeighbour = 0
	for (let step = 0; step < 5 * 60; step++) {
		bodies = stepLanternOrbMotion(bodies, 1 / 60, {
			time: step / 60,
			amplitude: 1,
		})
		for (const body of bodies) {
			const fromCentre = Math.hypot(
				body.x - landingLanternCavity.x,
				body.y - landingLanternCavity.y,
			)
			const limit = landingLanternCavity.r - body.radius - 0.008
			expect(fromCentre).toBeLessThanOrEqual(limit + 1e-6)
			expect(insideAperture(body)).toBe(true)
			if (step < 40 && body.id !== 'apps') {
				peakNeighbour = Math.max(peakNeighbour, Math.hypot(body.vx, body.vy))
			}
		}
	}
	expect(peakNeighbour).toBeGreaterThan(0.15)
	for (const body of bodies) {
		expect(body.coasting).toBe(false)
		expect(Math.hypot(body.vx, body.vy)).toBeLessThan(0.08)
	}
})
