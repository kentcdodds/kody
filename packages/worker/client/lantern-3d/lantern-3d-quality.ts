/**
 * Render resolution for the 3D lantern. It starts at the device pixel
 * ratio, capped so a large canvas cannot ask for more than `maxPixels`,
 * and steps down while frames run long. It does not climb back, so a
 * device that ran slow once settles instead of oscillating.
 *
 * Before any of that, the first second of frames decides whether the
 * device shows the 3D lantern at all (`lanternTrialSpeed`).
 */

export type LanternQuality = {
	pixelRatio: number
	/** Whether it has stepped down, so a resize keeps the lower ratio. */
	dropped: boolean
	/** Smoothed frame time, milliseconds. */
	frameMs: number
	/** How long frames have run slow without a break, milliseconds. */
	slowForMs: number
	/** Hitch-length frames in a row. */
	longFrames: number
}

export type LanternQualityOptions = {
	devicePixelRatio: number
	cssPixels: number
	maxPixels: number
}

/** Under about 42 frames a second counts as slow. */
const slowFrameMs = 24

/** Slow frames must last this long before the resolution drops. */
const slowWindowMs = 900

/** A frame this long is a hitch (tab switch, GC, scroll), not a trend,
 *  unless the next ones run as long. */
const hitchMs = 250
const hitchRun = 3

const dropFactor = 0.8

/** The lowest ratio it steps down to. */
const floorRatio = 1

/** How long the trial watches, milliseconds of frame timestamps. */
const trialMs = 1000

/** Trial frames slower than this on average (under 20 frames a second)
 *  keep the 2D lantern. Battery savers that hold 30 still pass. */
const trialFrameMs = 50

export function createLanternQuality(
	options: LanternQualityOptions,
): LanternQuality {
	return {
		pixelRatio: lanternPixelRatioCap(options),
		dropped: false,
		frameMs: 1000 / 60,
		slowForMs: 0,
		longFrames: 0,
	}
}

/** The sharpest ratio a canvas of `cssPixels` gets on this device. */
export function lanternPixelRatioCap(options: LanternQualityOptions) {
	const device = Math.min(Math.max(options.devicePixelRatio || 1, 1), 3)
	const budget =
		options.cssPixels > 0
			? Math.sqrt(options.maxPixels / options.cssPixels)
			: device
	return roundRatio(Math.max(Math.min(device, budget), floorRatio))
}

/** A new canvas size moves the cap, but a device that stepped down keeps
 *  its lower ratio. */
export function resizeLanternQuality(
	quality: LanternQuality,
	options: LanternQualityOptions,
): LanternQuality {
	const fresh = createLanternQuality(options)
	if (!quality.dropped) return fresh
	return {
		...quality,
		pixelRatio: Math.min(fresh.pixelRatio, quality.pixelRatio),
	}
}

export function stepLanternQuality(
	quality: LanternQuality,
	frameMs: number,
): LanternQuality {
	if (!(frameMs > 0)) return quality
	const longFrames = frameMs > hitchMs ? quality.longFrames + 1 : 0
	if (longFrames > 0 && longFrames < hitchRun) {
		return { ...quality, longFrames }
	}
	const sample = Math.min(frameMs, hitchMs)
	const smoothed = quality.frameMs + (sample - quality.frameMs) * 0.08
	const slowForMs = smoothed > slowFrameMs ? quality.slowForMs + sample : 0
	if (slowForMs < slowWindowMs || quality.pixelRatio <= floorRatio) {
		return { ...quality, frameMs: smoothed, slowForMs, longFrames }
	}
	return {
		pixelRatio: roundRatio(
			Math.max(quality.pixelRatio * dropFactor, floorRatio),
		),
		dropped: true,
		// Give the new size a fresh window before judging it.
		frameMs: 1000 / 60,
		slowForMs: 0,
		longFrames,
	}
}

/**
 * The trial's verdict from the timestamps of frames drawn one after
 * another: null until they span a second, then whether they averaged
 * under 20 a second. Not the typical gap: a renderer that falls behind
 * can stall every other frame, so half its gaps still look quick.
 */
export function lanternTrialSpeed(
	stamps: ReadonlyArray<number>,
): 'fast' | 'slow' | null {
	const first = stamps[0]
	const last = stamps.at(-1)
	if (first === undefined || last === undefined || last - first < trialMs) {
		return null
	}
	return (last - first) / (stamps.length - 1) > trialFrameMs ? 'slow' : 'fast'
}

function roundRatio(value: number) {
	return Math.round(value * 100) / 100
}
