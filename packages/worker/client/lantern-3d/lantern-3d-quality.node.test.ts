import { expect, test } from 'vitest'
import {
	createLanternQuality,
	lanternPixelRatioCap,
	resizeLanternQuality,
	stepLanternQuality,
	type LanternQuality,
} from './lantern-3d-quality.ts'

const maxPixels = 2_200_000
const laptop = {
	devicePixelRatio: 2,
	cssPixels: 470 * 640,
	maxPixels,
	software: false,
}

function frames(quality: LanternQuality, frameMs: number, seconds: number) {
	let next = quality
	const count = Math.round((seconds * 1000) / frameMs)
	for (let index = 0; index < count; index++) {
		next = stepLanternQuality(next, frameMs)
	}
	return next
}

test('the lantern renders at the device ratio until the canvas gets too big', () => {
	expect(lanternPixelRatioCap(laptop)).toBe(2)
	expect(
		lanternPixelRatioCap({
			devicePixelRatio: 3,
			cssPixels: 320 * 440,
			maxPixels,
		}),
	).toBe(3)
	expect(
		lanternPixelRatioCap({
			devicePixelRatio: 2,
			cssPixels: 1100 * 1500,
			maxPixels,
		}),
	).toBe(1.15)
	expect(
		lanternPixelRatioCap({
			devicePixelRatio: 2,
			cssPixels: 3000 * 2000,
			maxPixels,
		}),
	).toBe(1)
	expect(
		lanternPixelRatioCap({ devicePixelRatio: 0, cssPixels: 0, maxPixels }),
	).toBe(1)
	expect(createLanternQuality(laptop).pixelRatio).toBe(2)
})

test('sustained slow frames step the resolution down and it stays down', () => {
	const smooth = frames(createLanternQuality(laptop), 1000 / 60, 10)
	expect(smooth.pixelRatio).toBe(2)

	// One long hitch is a tab switch or a GC pause, not a slow device.
	expect(stepLanternQuality(smooth, 400)).toEqual({ ...smooth, longFrames: 1 })
	expect(frames(stepLanternQuality(smooth, 400), 1000 / 60, 2).pixelRatio).toBe(
		2,
	)
	const hitchy = frames(frames(smooth, 30, 0.3), 1000 / 60, 2)
	expect(hitchy.pixelRatio).toBe(2)

	const slow = frames(smooth, 40, 1.5)
	expect(slow).toMatchObject({ pixelRatio: 1.6, dropped: true })
	const slower = frames(slow, 40, 6)
	expect(slower.pixelRatio).toBe(1)

	const recovered = frames(slower, 1000 / 60, 30)
	expect(recovered.pixelRatio).toBe(1)
	expect(frames(slow, 1000 / 60, 30).pixelRatio).toBe(1.6)
})

test('a device too slow for any frame to pass as a hitch still steps down', () => {
	const crawling = frames(createLanternQuality(laptop), 300, 6)
	expect(crawling).toMatchObject({ pixelRatio: 1, dropped: true })
})

test('a software renderer starts below the device ratio and may go lower', () => {
	const start = createLanternQuality({ ...laptop, software: true })
	expect(start).toMatchObject({ pixelRatio: 0.75, floor: 0.5 })
	expect(frames(start, 100, 10).pixelRatio).toBe(0.5)
	expect(
		createLanternQuality({
			devicePixelRatio: 1,
			cssPixels: 3000 * 2000,
			maxPixels,
			software: true,
		}).pixelRatio,
	).toBe(0.75)
})

test('a resize follows the new cap unless the device already stepped down', () => {
	const bigger = { ...laptop, cssPixels: 1100 * 1500 }
	const smaller = { ...laptop, cssPixels: 320 * 440 }
	const start = createLanternQuality(laptop)
	expect(resizeLanternQuality(start, bigger).pixelRatio).toBe(1.15)
	expect(
		resizeLanternQuality(resizeLanternQuality(start, bigger), smaller)
			.pixelRatio,
	).toBe(2)

	const slow = frames(start, 40, 1.5)
	expect(resizeLanternQuality(slow, smaller)).toMatchObject({
		pixelRatio: 1.6,
		dropped: true,
	})
	expect(resizeLanternQuality(slow, bigger).pixelRatio).toBe(1.15)
})
