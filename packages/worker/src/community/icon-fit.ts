/**
 * Shared ingest fit for package icons and integration / MCP logos.
 *
 * Source files may be up to 4096px / 2 MiB. The UI paints them at ~56–88 CSS
 * pixels, so derived assets are scaled down to {@link iconFitMaxDimension} and
 * re-encoded as WebP once, then stored in R2. Cloudflare Images runs the
 * raster work off-isolate so a 16-megapixel upload cannot OOM the Worker.
 */

export const iconFitVersion = 2 as const
export const iconFitMaxDimension = 256
export const iconFitWebpQuality = 90
export const iconFitMetadataKey = 'iconFitVersion'
export const publicFittedIconCacheControl =
	'public, max-age=31536000, immutable'
export const iconFitOutputContentType = 'image/webp' as const

const maxFittedIconBytes = 2 * 1024 * 1024

export type FittedIconRaster = {
	bytes: Uint8Array
	contentType: typeof iconFitOutputContentType
}

export function iconFitCustomMetadata(
	extra?: Record<string, string>,
): Record<string, string> {
	return {
		...extra,
		[iconFitMetadataKey]: String(iconFitVersion),
	}
}

export function logoNeedsIconFit(
	metadata: Record<string, string> | undefined,
): boolean {
	return metadata?.[iconFitMetadataKey] !== String(iconFitVersion)
}

export function uint8ArrayToStream(
	bytes: Uint8Array,
): ReadableStream<Uint8Array> {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	return new Blob([copy]).stream()
}

export async function fitIconRaster(input: {
	images: ImagesBinding
	bytes: Uint8Array
}): Promise<FittedIconRaster> {
	const result = await input.images
		.input(uint8ArrayToStream(input.bytes))
		.transform({
			width: iconFitMaxDimension,
			height: iconFitMaxDimension,
			fit: 'scale-down',
		})
		.output({
			format: iconFitOutputContentType,
			quality: iconFitWebpQuality,
			anim: false,
		})
	const contentType = result.contentType()
	if (contentType !== iconFitOutputContentType) {
		throw new Error(
			`Icon fit produced ${contentType} instead of ${iconFitOutputContentType}.`,
		)
	}
	const bytes = new Uint8Array(await result.response().arrayBuffer())
	if (bytes.byteLength === 0 || bytes.byteLength > maxFittedIconBytes) {
		throw new Error(
			`Fitted icons must be between 1 byte and ${maxFittedIconBytes} bytes.`,
		)
	}
	return { bytes, contentType: iconFitOutputContentType }
}

export async function convertIconRasterToPng(input: {
	images: ImagesBinding
	bytes: Uint8Array
}): Promise<Uint8Array> {
	const result = await input.images
		.input(uint8ArrayToStream(input.bytes))
		.output({ format: 'image/png', anim: false })
	if (result.contentType() !== 'image/png') {
		throw new Error(
			`Icon PNG conversion produced ${result.contentType()} instead of image/png.`,
		)
	}
	const bytes = new Uint8Array(await result.response().arrayBuffer())
	if (bytes.byteLength === 0) {
		throw new Error('Icon PNG conversion produced an empty image.')
	}
	return bytes
}
