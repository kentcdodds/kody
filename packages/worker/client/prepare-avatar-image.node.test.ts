import { expect, test } from 'vitest'
import {
	prepareAvatarImage,
	prepareDecodedAvatarImage,
	userAvatarBrowserEncodeMaxDimension,
	type EncodeAvatarImageInput,
	type PrepareAvatarImageHost,
} from './prepare-avatar-image.ts'
import {
	userAvatarMaxDimension,
	userAvatarMaxSourceBytes,
	userAvatarMinDimension,
} from '#universal/user-avatar-limits.ts'

function createHost(input: {
	width: number
	height: number
	encode?: (request: EncodeAvatarImageInput) => Blob
}): PrepareAvatarImageHost {
	return {
		async decodeImage() {
			return { width: input.width, height: input.height }
		},
		async encodeImage(request) {
			if (input.encode) return input.encode(request)
			return new Blob([Uint8Array.from([1, 2, 3])], {
				type: request.contentType,
			})
		},
	}
}

test('prepareAvatarImage converts, resizes, crops, and rejects unusable photos', async () => {
	const readyJpeg = new File([Uint8Array.from([1, 2, 3, 4])], 'ready.jpg', {
		type: 'image/jpeg',
	})
	await expect(
		prepareAvatarImage(
			readyJpeg,
			createHost({
				width: 128,
				height: 128,
				encode: () => {
					throw new Error('ready images should not be re-encoded')
				},
			}),
		),
	).resolves.toBe(readyJpeg)

	const heic = new File([Uint8Array.from([9, 9, 9])], 'photo.heic', {
		type: 'image/heic',
	})
	const converted = await prepareAvatarImage(
		heic,
		createHost({
			width: 800,
			height: 600,
			encode: (request) =>
				new Blob([Uint8Array.from([5, 6, 7])], { type: request.contentType }),
		}),
	)
	expect(converted).not.toBe(heic)
	expect(converted.type).toBe('image/webp')
	expect(converted.name).toBe('photo.webp')
	expect(converted.size).toBe(3)

	const oversized = new File([new Uint8Array(2000)], 'huge.jpg', {
		type: 'image/jpeg',
	})
	const encodeCalls: Array<EncodeAvatarImageInput> = []
	await prepareAvatarImage(
		oversized,
		createHost({
			width: 8000,
			height: 4000,
			encode: (request) => {
				encodeCalls.push(request)
				return new Blob([Uint8Array.from([1])], { type: 'image/webp' })
			},
		}),
	)
	expect(encodeCalls[0]?.width).toBe(userAvatarBrowserEncodeMaxDimension)
	expect(encodeCalls[0]?.height).toBe(userAvatarBrowserEncodeMaxDimension / 2)
	expect(encodeCalls[0]?.sourceWidth).toBe(8000)

	const panorama = new File([new Uint8Array(2000)], 'wide.jpg', {
		type: 'image/jpeg',
	})
	const cropCalls: Array<EncodeAvatarImageInput> = []
	await prepareAvatarImage(
		panorama,
		createHost({
			width: 900,
			height: 100,
			encode: (request) => {
				cropCalls.push(request)
				return new Blob([Uint8Array.from([1])], { type: 'image/jpeg' })
			},
		}),
	)
	expect(cropCalls[0]).toMatchObject({
		sourceX: 300,
		sourceY: 0,
		sourceWidth: 300,
		sourceHeight: 100,
		width: 300,
		height: 100,
	})

	const banner = new File([new Uint8Array(2000)], 'wide-banner.png', {
		type: 'image/png',
	})
	const bannerCalls: Array<EncodeAvatarImageInput> = []
	await prepareAvatarImage(
		banner,
		createHost({
			width: 2400,
			height: 400,
			encode: (request) => {
				bannerCalls.push(request)
				return new Blob([Uint8Array.from([1])], { type: 'image/png' })
			},
		}),
	)
	expect(bannerCalls[0]).toMatchObject({
		sourceX: 600,
		sourceY: 0,
		sourceWidth: 1200,
		sourceHeight: 400,
		width: 1024,
		height: 342,
	})
	expect(
		Math.max(bannerCalls[0]?.width ?? 0, bannerCalls[0]?.height ?? 0) /
			Math.min(bannerCalls[0]?.width ?? 1, bannerCalls[0]?.height ?? 1),
	).toBeLessThanOrEqual(3)

	const squareCropCalls: Array<EncodeAvatarImageInput> = []
	await prepareDecodedAvatarImage(
		banner,
		{ width: 2400, height: 400 },
		{
			async decodeImage() {
				throw new Error('decoded bitmaps should not be decoded again')
			},
			async encodeImage(request) {
				squareCropCalls.push(request)
				return new Blob([Uint8Array.from([1])], { type: 'image/jpeg' })
			},
		},
		{ sourceX: 1000, sourceY: 0, sourceWidth: 400, sourceHeight: 400 },
	)
	expect(squareCropCalls[0]).toMatchObject({
		sourceX: 1000,
		sourceY: 0,
		sourceWidth: 400,
		sourceHeight: 400,
		width: 400,
		height: 400,
	})

	const tiny = new File([Uint8Array.from([1])], 'tiny.png', {
		type: 'image/png',
	})
	await expect(
		prepareAvatarImage(tiny, createHost({ width: 32, height: 32 })),
	).rejects.toThrow(
		`between ${userAvatarMinDimension}px and ${userAvatarMaxDimension}px`,
	)

	const unreadHeic = new File([Uint8Array.from([1])], 'iphone.heic', {
		type: '',
	})
	await expect(prepareAvatarImage(unreadHeic)).rejects.toThrow(/HEIC/)

	const tooHeavy = new File(
		[new Uint8Array(userAvatarMaxSourceBytes + 1)],
		'heavy.avif',
		{ type: 'image/avif' },
	)
	await expect(
		prepareAvatarImage(
			tooHeavy,
			createHost({
				width: 512,
				height: 512,
				encode: () =>
					new Blob([new Uint8Array(userAvatarMaxSourceBytes + 1)], {
						type: 'image/webp',
					}),
			}),
		),
	).rejects.toThrow(`${userAvatarMaxSourceBytes} bytes`)

	const stubborn = new File(
		[new Uint8Array(userAvatarMaxSourceBytes + 1)],
		'huge.avif',
		{ type: 'image/avif' },
	)
	const stubbornWidths: Array<number> = []
	const prepared = await prepareAvatarImage(
		stubborn,
		createHost({
			width: 8000,
			height: 8000,
			encode: (request) => {
				stubbornWidths.push(request.width)
				const stillTooBig = request.width >= userAvatarBrowserEncodeMaxDimension
				return new Blob(
					[new Uint8Array(stillTooBig ? userAvatarMaxSourceBytes + 1 : 12)],
					{ type: 'image/webp' },
				)
			},
		}),
	)
	expect(prepared.size).toBe(12)
	expect(stubbornWidths[0]).toBe(userAvatarBrowserEncodeMaxDimension)
	expect(stubbornWidths.at(-1)).toBeLessThan(
		userAvatarBrowserEncodeMaxDimension,
	)
})
