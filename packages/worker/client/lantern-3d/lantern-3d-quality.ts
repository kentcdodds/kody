/**
 * Render resolution for the 3D lantern. It starts at the device pixel
 * ratio, capped so a large canvas cannot ask for more than `maxPixels`,
 * and steps down while frames run long. It does not climb back, so a
 * device that ran slow once settles instead of oscillating.
 *
 * A software renderer pays CPU time for every pixel, so it starts below
 * the device ratio and may settle lower than a GPU would.
 */

export type LanternQuality = {
	pixelRatio: number
	/** The lowest ratio it steps down to. */
	floor: number
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
	software: boolean
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
const gpu = { start: Number.POSITIVE_INFINITY, floor: 1 }
const software = { start: 0.75, floor: 0.5 }

export function createLanternQuality(
	options: LanternQualityOptions,
): LanternQuality {
	const limits = options.software ? software : gpu
	return {
		pixelRatio: Math.min(lanternPixelRatioCap(options), limits.start),
		floor: limits.floor,
		dropped: false,
		frameMs: 1000 / 60,
		slowForMs: 0,
		longFrames: 0,
	}
}

/** The sharpest ratio a canvas of `cssPixels` gets on this device. */
export function lanternPixelRatioCap(
	options: Omit<LanternQualityOptions, 'software'>,
) {
	const device = Math.min(Math.max(options.devicePixelRatio || 1, 1), 3)
	const budget =
		options.cssPixels > 0
			? Math.sqrt(options.maxPixels / options.cssPixels)
			: device
	return roundRatio(Math.max(Math.min(device, budget), gpu.floor))
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
	if (slowForMs < slowWindowMs || quality.pixelRatio <= quality.floor) {
		return { ...quality, frameMs: smoothed, slowForMs, longFrames }
	}
	return {
		pixelRatio: roundRatio(
			Math.max(quality.pixelRatio * dropFactor, quality.floor),
		),
		floor: quality.floor,
		dropped: true,
		// Give the new size a fresh window before judging it.
		frameMs: 1000 / 60,
		slowForMs: 0,
		longFrames,
	}
}

function roundRatio(value: number) {
	return Math.round(value * 100) / 100
}
