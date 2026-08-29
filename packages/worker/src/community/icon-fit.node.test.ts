import { expect, test } from 'vitest'
import {
	convertIconRasterToPng,
	fitIconRaster,
	iconFitCustomMetadata,
	iconFitMetadataKey,
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
	expect(fitted.contentType).toBe('image/webp')
	expect(fitted.bytes).toEqual(tinyWebpBytes)
	expect(images.calls).toEqual([
		{
			inputBytes: tinyPngBytes,
			transform: {
				width: 256,
				height: 256,
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
	expect(logoNeedsIconFit(iconFitCustomMetadata())).toBe(false)

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
