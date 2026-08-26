/**
 * Pure crop/zoom helpers for the account avatar editor. Kept free of DOM
 * and framework imports so they can be unit tested directly.
 */

import { userAvatarMinDimension } from '#universal/user-avatar-limits.ts'

/** How far the user can zoom in relative to the cover (fit) scale. */
export const userAvatarCropMaxZoom = 4

export type AvatarCropRect = {
	sourceX: number
	sourceY: number
	sourceWidth: number
	sourceHeight: number
}

export type AvatarCropBounds = {
	imageWidth: number
	imageHeight: number
	viewportSize: number
}

export type AvatarCropTransform = {
	scale: number
	offsetX: number
	offsetY: number
}

export function coverScale(bounds: AvatarCropBounds): number {
	const shortest = Math.min(bounds.imageWidth, bounds.imageHeight)
	if (shortest <= 0 || bounds.viewportSize <= 0) return 1
	return bounds.viewportSize / shortest
}

export function maxScale(bounds: AvatarCropBounds): number {
	const cover = coverScale(bounds)
	if (bounds.viewportSize <= 0) return cover
	const minCropScale = bounds.viewportSize / userAvatarMinDimension
	return Math.max(cover, Math.min(cover * userAvatarCropMaxZoom, minCropScale))
}

export function initialCoverTransform(
	bounds: AvatarCropBounds,
): AvatarCropTransform {
	const scale = coverScale(bounds)
	return clampTransform(bounds, {
		scale,
		offsetX: (bounds.viewportSize - bounds.imageWidth * scale) / 2,
		offsetY: (bounds.viewportSize - bounds.imageHeight * scale) / 2,
	})
}

export function clampTransform(
	bounds: AvatarCropBounds,
	transform: AvatarCropTransform,
): AvatarCropTransform {
	const scale = clampNumber(
		transform.scale,
		coverScale(bounds),
		maxScale(bounds),
	)
	const minX = bounds.viewportSize - bounds.imageWidth * scale
	const minY = bounds.viewportSize - bounds.imageHeight * scale
	return {
		scale,
		offsetX: clampNumber(transform.offsetX, Math.min(0, minX), 0),
		offsetY: clampNumber(transform.offsetY, Math.min(0, minY), 0),
	}
}

export function panBy(
	bounds: AvatarCropBounds,
	transform: AvatarCropTransform,
	deltaX: number,
	deltaY: number,
): AvatarCropTransform {
	return clampTransform(bounds, {
		scale: transform.scale,
		offsetX: transform.offsetX + deltaX,
		offsetY: transform.offsetY + deltaY,
	})
}

export function zoomAtPoint(
	bounds: AvatarCropBounds,
	transform: AvatarCropTransform,
	nextScale: number,
	originX: number,
	originY: number,
): AvatarCropTransform {
	if (transform.scale <= 0) return initialCoverTransform(bounds)
	const imageX = (originX - transform.offsetX) / transform.scale
	const imageY = (originY - transform.offsetY) / transform.scale
	return clampTransform(bounds, {
		scale: nextScale,
		offsetX: originX - imageX * nextScale,
		offsetY: originY - imageY * nextScale,
	})
}

/**
 * Keep the same source crop when the on-screen viewport is measured or
 * rotates. Scale and offsets are multiplied by the viewport size ratio.
 */
export function resizeTransform(
	previous: AvatarCropBounds,
	next: AvatarCropBounds,
	transform: AvatarCropTransform,
): AvatarCropTransform {
	if (previous.viewportSize <= 0) return initialCoverTransform(next)
	const factor = next.viewportSize / previous.viewportSize
	return clampTransform(next, {
		scale: transform.scale * factor,
		offsetX: transform.offsetX * factor,
		offsetY: transform.offsetY * factor,
	})
}

export function cropRectFromTransform(
	bounds: AvatarCropBounds,
	transform: AvatarCropTransform,
): AvatarCropRect {
	const shortest = Math.min(bounds.imageWidth, bounds.imageHeight)
	const rawSize =
		transform.scale <= 0 ? shortest : bounds.viewportSize / transform.scale
	const size = clampNumber(
		Math.round(rawSize),
		Math.min(userAvatarMinDimension, shortest),
		shortest,
	)
	const sourceX = clampNumber(
		Math.round(-transform.offsetX / transform.scale),
		0,
		Math.max(0, bounds.imageWidth - size),
	)
	const sourceY = clampNumber(
		Math.round(-transform.offsetY / transform.scale),
		0,
		Math.max(0, bounds.imageHeight - size),
	)
	return {
		sourceX,
		sourceY,
		sourceWidth: size,
		sourceHeight: size,
	}
}

function clampNumber(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value))
}
