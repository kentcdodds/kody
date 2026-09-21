import { expect, test } from 'vitest'
import { landingLanternOrbs } from './landing-lantern.ts'
import {
	clampToCavity,
	createLanternOrbBodies,
	landingLanternCavity,
	stepLanternOrbMotion,
	type LanternOrbBody,
} from './landing-lantern-motion.ts'

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
			if (limit - fromCentre < 0.01) wallTouches++
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
	const rel = (met[0]!.vx - met[2]!.vx) * 1 + (met[0]!.vy - met[2]!.vy) * 0
	expect(rel).toBeGreaterThan(-0.01)
	expect(rel).toBeLessThan(0.02)
})
