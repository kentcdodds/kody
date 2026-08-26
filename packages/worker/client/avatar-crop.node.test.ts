import { expect, test } from 'vitest'
import {
	clampTransform,
	coverScale,
	cropRectFromTransform,
	initialCoverTransform,
	maxScale,
	panBy,
	resizeTransform,
	userAvatarCropMaxZoom,
	zoomAtPoint,
} from './avatar-crop.ts'
import { userAvatarMinDimension } from '#universal/user-avatar-limits.ts'

test('avatar crop math covers, pans, zooms, and stays a square in-bounds crop', () => {
	const viewportSize = 280
	const landscape = {
		imageWidth: 2400,
		imageHeight: 400,
		viewportSize,
	}
	expect(coverScale(landscape)).toBe(viewportSize / 400)
	const start = initialCoverTransform(landscape)
	expect(start.offsetY).toBe(0)
	expect(start.offsetX).toBe((viewportSize - 2400 * start.scale) / 2)

	const coverCrop = cropRectFromTransform(landscape, start)
	expect(coverCrop).toEqual({
		sourceX: 1000,
		sourceY: 0,
		sourceWidth: 400,
		sourceHeight: 400,
	})

	const pannedOffTheEdge = panBy(landscape, start, 4000, 4000)
	expect(pannedOffTheEdge.offsetX).toBe(0)
	expect(pannedOffTheEdge.offsetY).toBe(0)
	expect(cropRectFromTransform(landscape, pannedOffTheEdge).sourceX).toBe(0)

	const zoomed = zoomAtPoint(
		landscape,
		start,
		start.scale * userAvatarCropMaxZoom,
		viewportSize / 2,
		viewportSize / 2,
	)
	expect(zoomed.scale).toBe(maxScale(landscape))
	const zoomedCrop = cropRectFromTransform(landscape, zoomed)
	expect(zoomedCrop.sourceWidth).toBe(zoomedCrop.sourceHeight)
	expect(zoomedCrop.sourceWidth).toBeGreaterThanOrEqual(userAvatarMinDimension)
	expect(zoomedCrop.sourceX).toBeGreaterThanOrEqual(0)
	expect(zoomedCrop.sourceX + zoomedCrop.sourceWidth).toBeLessThanOrEqual(2400)

	const rotated = {
		imageWidth: 2400,
		imageHeight: 400,
		viewportSize: 160,
	}
	const resized = resizeTransform(landscape, rotated, zoomed)
	const resizedCrop = cropRectFromTransform(rotated, resized)
	expect(resizedCrop.sourceWidth).toBe(resizedCrop.sourceHeight)
	expect(resizedCrop.sourceWidth).toBe(zoomedCrop.sourceWidth)
	expect(resizedCrop.sourceX).toBe(zoomedCrop.sourceX)

	const tiny = {
		imageWidth: 80,
		imageHeight: 80,
		viewportSize,
	}
	expect(maxScale(tiny)).toBe(viewportSize / userAvatarMinDimension)
	expect(
		cropRectFromTransform(tiny, initialCoverTransform(tiny)).sourceWidth,
	).toBe(80)

	const square = {
		imageWidth: 800,
		imageHeight: 800,
		viewportSize,
	}
	const clamped = clampTransform(square, {
		scale: 0.01,
		offsetX: 50,
		offsetY: -900,
	})
	expect(clamped.scale).toBe(coverScale(square))
	expect(clamped.offsetX).toBe(0)
	expect(clamped.offsetY).toBe(0)
})
