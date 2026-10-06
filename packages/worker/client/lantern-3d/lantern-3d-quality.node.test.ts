import { expect, test } from 'vitest'
import {
	createLanternQuality,
	lanternPixelRatioCap,
	lanternTrialSpeed,
	resizeLanternQuality,
	stepLanternQuality,
	type LanternQuality,
} from './lantern-3d-quality.ts'

const maxPixels = 2_200_000
const laptop = {
	devicePixelRatio: 2,
	cssPixels: 470 * 640,
	maxPixels,
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

/** Timestamps spanning at least `seconds`, `frameMs` apart, from `from`. */
function stamps(frameMs: number, seconds: number, from = 5000) {
	const count = Math.ceil((seconds * 1000) / frameMs)
	return Array.from({ length: count + 1 }, (_, index) => from + index * frameMs)
}

/** The verdict as the scene reaches it, one frame at a time. */
function verdict(frames: ReadonlyArray<number>) {
	for (let end = 1; end <= frames.length; end++) {
		const speed = lanternTrialSpeed(frames.slice(0, end))
		if (speed) return speed
	}
	return null
}

test('the first second decides whether the 3D lantern shows', () => {
	expect(verdict([])).toBeNull()
	expect(verdict(stamps(1000 / 60, 0.5))).toBeNull()
	expect(verdict(stamps(1000 / 60, 1))).toBe('fast')
	// A battery saver's 30 frames a second, and a GPU that drops every other
	// frame, still show it.
	expect(verdict(stamps(1000 / 30, 1))).toBe('fast')
	expect(verdict(stamps(45, 1))).toBe('fast')
	// Under 20 frames a second does not, down to one frame in a second.
	expect(verdict(stamps(60, 1))).toBe('slow')
	expect(verdict(stamps(400, 1.2))).toBe('slow')
	expect(verdict([0, 1000])).toBe('slow')
})

test('a hitch or two in the first second does not hide the 3D lantern', () => {
	const smooth = stamps(1000 / 60, 2)
	const hitchy = [
		...smooth.slice(0, 20),
		...smooth.slice(20).map((stamp) => stamp + 300),
	]
	expect(verdict(hitchy)).toBe('fast')
	const twice = [
		...hitchy.slice(0, 40),
		...hitchy.slice(40).map((stamp) => stamp + 250),
	]
	expect(verdict(twice)).toBe('fast')
})

test('a renderer that stalls between quick frames keeps the 2D lantern', () => {
	// Frame gaps from SwiftShader in a worker on a machine without a GPU:
	// some frames only queue their drawing and the next one waits for all
	// of it, so most gaps look quick.
	const gaps = [16.6, 16.7, 150, 16.7, 416.7, 16.6, 50, 2416.6, 466.6, 16.7]
	const frames = [5000]
	for (const gap of gaps) frames.push(frames.at(-1)! + gap)
	expect(verdict(frames)).toBe('slow')
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
