import { expect, test } from 'vitest'
import {
	listCodingWalkthroughHosts,
	pickWalkthroughHosts,
} from '#universal/walkthrough-hosts.ts'
import {
	landingByokBeelineCubic,
	landingByokCubicPoint,
	landingByokDemoShouldAnimate,
	landingByokLoopFlags,
	landingByokLoopPoint,
	pickByokDemoHost,
} from './landing-byok-demo.tsx'

test('BYOK cursor follows the walkthrough chooser coding host', () => {
	const catalogCoding = listCodingWalkthroughHosts()[0]!
	const fallback = pickByokDemoHost()
	expect(fallback.id).toBe(catalogCoding.id)
	expect(fallback.icon).toBe(catalogCoding.icon)

	const pickA = pickWalkthroughHosts(() => 0)
	const pickB = pickWalkthroughHosts((max) => Math.max(0, max - 1))
	expect(pickByokDemoHost(pickA).id).toBe(pickA.coding.id)
	expect(pickByokDemoHost(pickB).id).toBe(pickB.coding.id)
	expect(pickByokDemoHost(pickA).id).not.toBe(pickByokDemoHost(pickB).id)

	const otherCoding = listCodingWalkthroughHosts().find(
		(host) => host.id !== pickA.coding.id,
	)
	expect(otherCoding).toBeDefined()
	expect(
		pickByokDemoHost({
			...pickA,
			coding: otherCoding!,
		}).id,
	).toBe(otherCoding!.id)
})

test('BYOK demo stays parked when reduced motion is requested', () => {
	expect(landingByokDemoShouldAnimate(null)).toBe(false)
	expect(landingByokDemoShouldAnimate({ matches: true })).toBe(false)
	expect(landingByokDemoShouldAnimate({ matches: false })).toBe(true)
})

function lineSide(
	point: { x: number; y: number },
	from: { x: number; y: number },
	to: { x: number; y: number },
) {
	return (
		(to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x)
	)
}

test('BYOK cursor beelines with a cubic wobble and opposite return arc', () => {
	const from = { x: 0, y: 0 }
	const to = { x: 200, y: 0 }
	expect(landingByokLoopPoint(0.02, from, to)).toEqual(from)
	expect(landingByokLoopPoint(0.4, from, to)).toEqual(to)
	expect(landingByokLoopPoint(0.92, from, to)).toEqual(from)

	const outMid = landingByokLoopPoint(0.21, from, to)
	const inMid = landingByokLoopPoint(0.69, from, to)
	expect(Math.abs(lineSide(outMid, from, to))).toBeGreaterThan(800)
	expect(Math.abs(lineSide(inMid, from, to))).toBeGreaterThan(800)
	expect(Math.sign(lineSide(outMid, from, to))).not.toBe(
		Math.sign(lineSide(inMid, from, to)),
	)
	expect(outMid.x).toBeGreaterThan(40)
	expect(outMid.x).toBeLessThan(180)
	expect(inMid.x).toBeGreaterThan(20)
	expect(inMid.x).toBeLessThan(180)

	let farthest = 0
	for (let step = 0; step <= 24; step++) {
		const progress = 0.1 + (0.22 * step) / 24
		farthest = Math.max(farthest, landingByokLoopPoint(progress, from, to).x)
	}
	expect(farthest).toBeGreaterThan(200)

	const curve = landingByokBeelineCubic(from, to, 1)
	expect(landingByokCubicPoint(curve, 0)).toEqual(from)
	expect(landingByokCubicPoint(curve, 1)).toEqual(to)
	expect(landingByokLoopFlags(0.2)).toEqual({
		clicking: false,
		shaking: false,
	})
	expect(landingByokLoopFlags(0.38)).toEqual({
		clicking: true,
		shaking: true,
	})
	expect(landingByokLoopFlags(0.5)).toEqual({
		clicking: false,
		shaking: true,
	})
})
