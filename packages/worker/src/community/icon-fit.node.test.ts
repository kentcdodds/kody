import { expect, test } from 'vitest'
import {
	convertIconRasterToPng,
	fitIconRaster,
	iconFitCustomMetadata,
	iconFitMaxDimension,
	iconFitMetadataKey,
	iconFitOutputContentType,
	iconFitVersion,
	logoNeedsIconFit,
} from '#worker/community/icon-fit.ts'
import {
	createFakeImagesBinding,
	tinyPngBytes,
	tinyWebpBytes,
} from '#worker/test-support/images-binding.ts'

test('fitIconRaster asks Images to scale-down to 256px WebP and records fit metadata', async () => {
	const images = createFakeImagesBinding()
	const fitted = await fitIconRaster({
		images,
		bytes: tinyPngBytes,
	})
	expect(fitted.contentType).toBe(iconFitOutputContentType)
	expect(fitted.bytes).toEqual(tinyWebpBytes)
	expect(images.calls).toEqual([
		{
			inputBytes: tinyPngBytes,
			transform: {
				width: iconFitMaxDimension,
				height: iconFitMaxDimension,
				fit: 'scale-down',
			},
			output: {
				format: 'image/webp',
				quality: 90,
				anim: false,
			},
		},
	])
	expect(logoNeedsIconFit(undefined)).toBe(true)
	expect(logoNeedsIconFit({ [iconFitMetadataKey]: '1' })).toBe(true)
	expect(logoNeedsIconFit(iconFitCustomMetadata({ slug: 'github' }))).toBe(
		false,
	)
	expect(iconFitCustomMetadata({ slug: 'github' })).toEqual({
		slug: 'github',
		[iconFitMetadataKey]: String(iconFitVersion),
	})

	const png = await convertIconRasterToPng({
		images,
		bytes: tinyWebpBytes,
	})
	expect(png).toEqual(tinyPngBytes)
	expect(images.calls[1]?.output).toEqual({
		format: 'image/png',
		anim: false,
	})
})
