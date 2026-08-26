import {
	isUserAvatarOutputContentType,
	normalizeUserAvatarContentType,
	userAvatarMaxAspectRatio,
	userAvatarMaxDimension,
	userAvatarMaxSourceBytes,
	userAvatarMinDimension,
	type UserAvatarOutputContentType,
} from '#universal/user-avatar-limits.ts'

/** Longest side the browser encoder writes. Server still allows 4096. */
export const userAvatarBrowserEncodeMaxDimension = 1024

export type AvatarImageBitmap = {
	width: number
	height: number
	close?: () => void
}

export type EncodeAvatarImageInput = {
	source: AvatarImageBitmap
	sourceX: number
	sourceY: number
	sourceWidth: number
	sourceHeight: number
	width: number
	height: number
	contentType: UserAvatarOutputContentType
	quality: number
}

export type PrepareAvatarImageHost = {
	decodeImage: (file: File) => Promise<AvatarImageBitmap>
	encodeImage: (input: EncodeAvatarImageInput) => Promise<Blob>
}

export type AvatarCropRect = {
	sourceX: number
	sourceY: number
	sourceWidth: number
	sourceHeight: number
}

const defaultHost: PrepareAvatarImageHost = {
	decodeImage: decodeImageWithBrowser,
	encodeImage: encodeImageWithBrowser,
}

export async function decodeAvatarImage(
	file: File,
	host: PrepareAvatarImageHost = defaultHost,
): Promise<AvatarImageBitmap> {
	if (file.size === 0) {
		throw new Error('Avatar file is required.')
	}
	try {
		return await host.decodeImage(file)
	} catch (error) {
		if (error instanceof Error) throw error
		throw createDecodeError(file)
	}
}

export async function prepareAvatarImage(
	file: File,
	host: PrepareAvatarImageHost = defaultHost,
): Promise<File> {
	const bitmap = await decodeAvatarImage(file, host)
	try {
		return await prepareDecodedAvatarImage(file, bitmap, host)
	} finally {
		bitmap.close?.()
	}
}

export async function prepareDecodedAvatarImage(
	file: File,
	bitmap: AvatarImageBitmap,
	host: PrepareAvatarImageHost = defaultHost,
	requestedCrop?: AvatarCropRect,
): Promise<File> {
	if (
		!Number.isFinite(bitmap.width) ||
		!Number.isFinite(bitmap.height) ||
		bitmap.width < userAvatarMinDimension ||
		bitmap.height < userAvatarMinDimension
	) {
		throw new Error(
			`Avatars must be between ${userAvatarMinDimension}px and ${userAvatarMaxDimension}px on each side.`,
		)
	}

	const crop = requestedCrop ?? cropToMaxAspect(bitmap.width, bitmap.height)
	assertCropFitsBitmap(bitmap, crop)
	const needsCrop =
		crop.sourceX !== 0 ||
		crop.sourceY !== 0 ||
		crop.sourceWidth !== bitmap.width ||
		crop.sourceHeight !== bitmap.height
	const acceptedType = normalizeUserAvatarContentType(file.type)
	const alreadyFitsServer =
		acceptedType !== null &&
		file.size <= userAvatarMaxSourceBytes &&
		bitmap.width <= userAvatarMaxDimension &&
		bitmap.height <= userAvatarMaxDimension &&
		!needsCrop

	if (alreadyFitsServer) return file

	let longest = Math.min(
		Math.max(crop.sourceWidth, crop.sourceHeight),
		userAvatarBrowserEncodeMaxDimension,
	)
	let quality = 0.86
	const preferredTypes = preferredOutputTypes(file)

	for (let attempt = 0; attempt < 12; attempt++) {
		const scaled = scaleToMaxDimension(
			crop.sourceWidth,
			crop.sourceHeight,
			Math.min(longest, userAvatarBrowserEncodeMaxDimension),
		)
		if (
			scaled.width < userAvatarMinDimension ||
			scaled.height < userAvatarMinDimension
		) {
			throw new Error(
				`Avatars must be between ${userAvatarMinDimension}px and ${userAvatarMaxDimension}px on each side.`,
			)
		}

		const blob = await encodeWithFallback(host, {
			source: bitmap,
			...crop,
			width: scaled.width,
			height: scaled.height,
			contentType: preferredTypes[0] ?? 'image/jpeg',
			quality,
		})
		if (blob.size <= userAvatarMaxSourceBytes) {
			const contentType =
				normalizeUserAvatarContentType(blob.type) ??
				preferredTypes[0] ??
				'image/jpeg'
			return new File([blob], fileNameForContentType(file.name, contentType), {
				type: contentType,
				lastModified: file.lastModified,
			})
		}

		if (quality > 0.55) {
			quality = Math.max(0.5, quality - 0.12)
			continue
		}
		if (longest > 256) {
			longest = Math.max(256, Math.floor(longest * 0.75))
			quality = 0.86
			continue
		}

		throw new Error(
			`Avatars must be between 1 byte and ${userAvatarMaxSourceBytes} bytes.`,
		)
	}

	throw new Error(
		`Avatars must be between 1 byte and ${userAvatarMaxSourceBytes} bytes.`,
	)
}

function assertCropFitsBitmap(bitmap: AvatarImageBitmap, crop: AvatarCropRect) {
	if (
		!Number.isFinite(crop.sourceX) ||
		!Number.isFinite(crop.sourceY) ||
		!Number.isFinite(crop.sourceWidth) ||
		!Number.isFinite(crop.sourceHeight) ||
		crop.sourceX < 0 ||
		crop.sourceY < 0 ||
		crop.sourceWidth < userAvatarMinDimension ||
		crop.sourceHeight < userAvatarMinDimension ||
		crop.sourceX + crop.sourceWidth > bitmap.width ||
		crop.sourceY + crop.sourceHeight > bitmap.height
	) {
		throw new Error(
			`Avatars must be between ${userAvatarMinDimension}px and ${userAvatarMaxDimension}px on each side.`,
		)
	}
}

function preferredOutputTypes(file: File): Array<UserAvatarOutputContentType> {
	if (file.type === 'image/png')
		return ['image/png', 'image/webp', 'image/jpeg']
	return ['image/webp', 'image/jpeg']
}

async function encodeWithFallback(
	host: PrepareAvatarImageHost,
	input: EncodeAvatarImageInput,
): Promise<Blob> {
	const requested = [input.contentType, 'image/jpeg', 'image/png'] as const
	const seen = new Set<UserAvatarOutputContentType>()
	for (const contentType of requested) {
		if (seen.has(contentType)) continue
		seen.add(contentType)
		const blob = await host.encodeImage({ ...input, contentType })
		if (blob.size === 0) continue
		if (
			blob.type === '' ||
			isUserAvatarOutputContentType(blob.type) ||
			blob.type === contentType
		) {
			return blob
		}
	}
	throw new Error('Unable to convert that image in the browser.')
}

export function cropToMaxAspect(
	width: number,
	height: number,
	maxAspect = userAvatarMaxAspectRatio,
): AvatarCropRect {
	const longer = Math.max(width, height)
	const shorter = Math.min(width, height)
	if (shorter <= 0 || longer / shorter <= maxAspect) {
		return {
			sourceX: 0,
			sourceY: 0,
			sourceWidth: width,
			sourceHeight: height,
		}
	}
	if (width >= height) {
		const sourceWidth = Math.floor(height * maxAspect)
		return {
			sourceX: Math.floor((width - sourceWidth) / 2),
			sourceY: 0,
			sourceWidth,
			sourceHeight: height,
		}
	}
	const sourceHeight = Math.floor(width * maxAspect)
	return {
		sourceX: 0,
		sourceY: Math.floor((height - sourceHeight) / 2),
		sourceWidth: width,
		sourceHeight,
	}
}

export function scaleToMaxDimension(
	width: number,
	height: number,
	maxDimension: number,
): { width: number; height: number } {
	const longest = Math.max(width, height)
	const scaled =
		longest <= maxDimension
			? { width, height }
			: {
					width: Math.max(1, Math.round(width * (maxDimension / longest))),
					height: Math.max(1, Math.round(height * (maxDimension / longest))),
				}
	return clampEncodedAspect(scaled.width, scaled.height)
}

/**
 * Rounding after a max-dimension scale can push a 3:1 crop just over the
 * server's `longer / shorter > 3` check (1200×400 → 1024×341). Grow the
 * shorter side so the encoded canvas stays within the stored-avatar limit.
 */
export function clampEncodedAspect(
	width: number,
	height: number,
	maxAspect = userAvatarMaxAspectRatio,
): { width: number; height: number } {
	const longer = Math.max(width, height)
	const shorter = Math.min(width, height)
	if (shorter <= 0 || longer / shorter <= maxAspect) {
		return { width, height }
	}
	const minShorter = Math.ceil(longer / maxAspect)
	if (width >= height) {
		return { width, height: minShorter }
	}
	return { width: minShorter, height }
}

export function isHeicLikeFile(file: File): boolean {
	const type = file.type.toLowerCase()
	const name = file.name.toLowerCase()
	return (
		type === 'image/heic' ||
		type === 'image/heif' ||
		name.endsWith('.heic') ||
		name.endsWith('.heif')
	)
}

function fileNameForContentType(
	originalName: string,
	contentType: UserAvatarOutputContentType,
): string {
	const trimmed = originalName.trim()
	const base = trimmed.replace(/\.[^.]+$/, '') || 'avatar'
	switch (contentType) {
		case 'image/png':
			return `${base}.png`
		case 'image/jpeg':
			return `${base}.jpg`
		case 'image/webp':
			return `${base}.webp`
		default: {
			const unreachable: never = contentType
			throw new Error(`Unsupported avatar content type: ${unreachable}`)
		}
	}
}

function createDecodeError(file: File): Error {
	if (isHeicLikeFile(file)) {
		return new Error(
			'This browser cannot convert HEIC photos. Open this page in Safari, or export the photo as JPEG.',
		)
	}
	return new Error(
		'Could not read that image in the browser. Try a PNG, JPEG, WebP, AVIF, or HEIC photo.',
	)
}

async function decodeImageWithBrowser(file: File): Promise<AvatarImageBitmap> {
	if (typeof createImageBitmap === 'function') {
		try {
			return await createImageBitmap(file, { imageOrientation: 'from-image' })
		} catch {
			// Some browsers expose HEIC/AVIF only through HTMLImageElement.
		}
	}
	if (typeof Image === 'undefined' || typeof URL === 'undefined') {
		throw createDecodeError(file)
	}

	const objectUrl = URL.createObjectURL(file)
	try {
		const image = new Image()
		image.src = objectUrl
		await image.decode()
		if (typeof createImageBitmap === 'function') {
			return await createImageBitmap(image, { imageOrientation: 'from-image' })
		}
		return image
	} catch {
		throw createDecodeError(file)
	} finally {
		URL.revokeObjectURL(objectUrl)
	}
}

async function encodeImageWithBrowser(
	input: EncodeAvatarImageInput,
): Promise<Blob> {
	const source = input.source as CanvasImageSource
	if (typeof OffscreenCanvas === 'function') {
		const canvas = new OffscreenCanvas(input.width, input.height)
		const context = canvas.getContext('2d')
		if (context) {
			context.drawImage(
				source,
				input.sourceX,
				input.sourceY,
				input.sourceWidth,
				input.sourceHeight,
				0,
				0,
				input.width,
				input.height,
			)
			if (typeof canvas.convertToBlob === 'function') {
				return await canvas.convertToBlob({
					type: input.contentType,
					quality: input.quality,
				})
			}
		}
	}

	if (typeof document === 'undefined') {
		throw new Error('Unable to convert that image in the browser.')
	}

	const canvas = document.createElement('canvas')
	canvas.width = input.width
	canvas.height = input.height
	const context = canvas.getContext('2d')
	if (!context) {
		throw new Error('Unable to convert that image in the browser.')
	}
	context.drawImage(
		source,
		input.sourceX,
		input.sourceY,
		input.sourceWidth,
		input.sourceHeight,
		0,
		0,
		input.width,
		input.height,
	)
	const blob = await new Promise<Blob | null>((resolve, reject) => {
		try {
			canvas.toBlob(resolve, input.contentType, input.quality)
		} catch (error) {
			reject(error)
		}
	})
	if (!blob) {
		throw new Error('Unable to convert that image in the browser.')
	}
	return blob
}
