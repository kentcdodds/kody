import { Color, ShaderMaterial } from 'three'
import { expect, test } from 'vitest'
import {
	constellationArrivals,
	constellationAt,
	constellationLeg,
	constellationTiming,
	createConstellationThread,
} from './lantern-3d-constellation.ts'

const legs = 5
const { first, every, leg, hold, fade } = constellationTiming
const run = legs * leg

test('the thread waits for a quiet spell, runs orb to orb, holds, and fades', () => {
	expect(constellationAt(0, legs)).toBeNull()
	expect(constellationAt(first - 0.01, legs)).toBeNull()
	expect(constellationAt(first, legs)).toEqual({ head: 0, settle: 0, glow: 1 })
	const running = constellationAt(first + leg * 2.5, legs)
	expect(running?.head).toBeCloseTo(2.5)
	expect(running?.settle).toBe(0)
	const holding = constellationAt(first + run + hold / 2, legs)
	expect(holding).toMatchObject({ head: legs, glow: 1 })
	expect(holding?.settle).toBeCloseTo(0.5)
	const fading = constellationAt(first + run + hold + fade / 2, legs)
	expect(fading).toMatchObject({ head: legs, settle: 1 })
	expect(fading?.glow).toBeCloseTo(0.5)
	expect(constellationAt(first + run + hold + fade + 0.001, legs)).toBeNull()
	expect(constellationAt(first + every - 1, legs)).toBeNull()
})

test('it comes back now and then while the visitor keeps watching', () => {
	expect(constellationAt(first + every, legs)).toEqual({
		head: 0,
		settle: 0,
		glow: 1,
	})
	expect(constellationAt(first + every * 3 + leg, legs)?.head).toBeCloseTo(1)
})

test('every orb chimes once per showing, in order, even across a slow frame', () => {
	const chimes: Array<number> = []
	let head: number | null = null
	for (let quiet = first - 1; quiet < first + every; quiet += 1 / 60) {
		const moment = constellationAt(quiet, legs)
		if (!moment) {
			head = null
			continue
		}
		chimes.push(...constellationArrivals(head, moment.head))
		head = moment.head
	}
	expect(chimes).toEqual([0, 1, 2, 3, 4, 5])
	expect(constellationArrivals(0.8, 2.3)).toEqual([1, 2])
	expect(constellationArrivals(2, 2)).toEqual([])
	expect(constellationArrivals(null, 0.4)).toEqual([0])
})

test('a leg runs rim to rim and skips orbs that touch', () => {
	const from = { x: 0, y: 0, z: 0, radius: 0.1 }
	const to = { x: 1, y: 0, z: 0, radius: 0.2 }
	expect(constellationLeg(from, to, 0)?.x).toBeCloseTo(0.115)
	expect(constellationLeg(from, to, 1)?.x).toBeCloseTo(0.77)
	expect(constellationLeg(from, to, 0.5)?.x).toBeCloseTo((0.115 + 0.77) / 2)
	expect(
		constellationLeg(from, { x: 0.3, y: 0, z: 0, radius: 0.2 }, 0.5),
	).toBeNull()
})

test('the thread lays its motes through the stops and tints each leg', () => {
	const thread = createConstellationThread(new ShaderMaterial(), 2)
	thread.place([
		{ x: 0, y: 1, z: 0, radius: 0.1 },
		{ x: 0, y: 0, z: 0, radius: 0.1 },
		{ x: 0.05, y: 0, z: 0, radius: 0.1 },
	])
	const positions = thread.points.geometry.getAttribute('position')
	const motes = positions.count / 2
	expect(positions.getY(0)).toBeCloseTo(1 - 0.115)
	expect(positions.getY(motes - 1)).toBeCloseTo(0.115)
	// The second pair overlap, so that leg is parked out of sight.
	expect(positions.getZ(motes)).toBe(-100)

	thread.paint([new Color(1, 0, 0), new Color(0, 0, 1), new Color(0, 1, 0)])
	const colors = thread.points.geometry.getAttribute('aColor')
	expect(colors.getX(0)).toBeCloseTo(1)
	expect(colors.getY(0)).toBeCloseTo(0.15)
	expect(colors.getZ(0)).toBeCloseTo(0.15)
	expect(colors.getX(motes - 1)).toBeCloseTo(0.15)
	expect(colors.getZ(motes - 1)).toBeCloseTo(1)
	thread.points.geometry.dispose()
})
