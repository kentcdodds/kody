import { expect, test } from 'vitest'
import {
	buildUserAvatarR2Key,
	getUserAvatarObject,
	parseUserAvatarCacheKey,
	processUserAvatar,
} from './avatar.ts'

function createPngHeader(width: number, height: number) {
	const bytes = new Uint8Array(24)
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	bytes.set([0x49, 0x48, 0x44, 0x52], 12)
	new DataView(bytes.buffer).setUint32(16, width)
	new DataView(bytes.buffer).setUint32(20, height)
	return bytes
}

function createWebpHeader(width: number, height: number) {
	const bytes = new Uint8Array(30)
	bytes.set(new TextEncoder().encode('RIFF'), 0)
	bytes.set(new TextEncoder().encode('WEBP'), 8)
	bytes.set(new TextEncoder().encode('VP8X'), 12)
	const view = new DataView(bytes.buffer)
	view.setUint8(24, (width - 1) & 0xff)
	view.setUint8(25, ((width - 1) >> 8) & 0xff)
	view.setUint8(26, ((width - 1) >> 16) & 0xff)
	view.setUint8(27, (height - 1) & 0xff)
	view.setUint8(28, ((height - 1) >> 8) & 0xff)
	view.setUint8(29, ((height - 1) >> 16) & 0xff)
	return bytes
}

function createJpegHeader(width: number, height: number) {
	return Uint8Array.from([
		0xff,
		0xd8,
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x03,
		0x01,
		0x11,
		0x00,
		0x02,
		0x11,
		0x00,
		0x03,
		0x11,
		0x00,
		0xff,
		0xd9,
	])
}

test('processUserAvatar accepts valid png/jpeg/webp and rejects unsafe inputs', () => {
	const png = createPngHeader(128, 128)
	const webp = createWebpHeader(320, 180)
	const jpeg = createJpegHeader(256, 256)

	expect(
		processUserAvatar({ contentType: 'image/png', sourceBytes: png }),
	).toEqual({ bytes: png, contentType: 'image/png' })
	expect(
		processUserAvatar({ contentType: 'image/webp', sourceBytes: webp }),
	).toEqual({ bytes: webp, contentType: 'image/webp' })
	expect(
		processUserAvatar({ contentType: 'image/jpeg', sourceBytes: jpeg }),
	).toEqual({ bytes: jpeg, contentType: 'image/jpeg' })
	expect(
		processUserAvatar({ contentType: 'image/jpg', sourceBytes: jpeg }),
	).toEqual({ bytes: jpeg, contentType: 'image/jpeg' })

	expect(() =>
		processUserAvatar({
			contentType: 'image/svg+xml',
			sourceBytes: new TextEncoder().encode('<svg></svg>'),
		}),
	).toThrow('PNG, JPEG, or WebP')

	expect(() =>
		processUserAvatar({
			contentType: 'image/png',
			sourceBytes: new Uint8Array(1_000_001),
		}),
	).toThrow('1000000 bytes')

	expect(() =>
		processUserAvatar({
			contentType: 'image/png',
			sourceBytes: createPngHeader(32, 32),
		}),
	).toThrow('between 64px and 4096px')

	expect(() =>
		processUserAvatar({
			contentType: 'image/png',
			sourceBytes: createPngHeader(5000, 128),
		}),
	).toThrow('between 64px and 4096px')

	expect(() =>
		processUserAvatar({
			contentType: 'image/png',
			sourceBytes: createPngHeader(640, 128),
		}),
	).toThrow('aspect ratio')
})

test('buildUserAvatarR2Key and parseUserAvatarCacheKey round-trip content hash segment', () => {
	expect(
		buildUserAvatarR2Key({
			stableUserId: 'stable-1',
			contentHash: 'abcdef',
			contentType: 'image/png',
		}),
	).toBe('user-avatars/stable-1/abcdef.png')
	expect(
		buildUserAvatarR2Key({
			stableUserId: 'stable-1',
			contentHash: 'abcdef',
			contentType: 'image/jpeg',
		}),
	).toBe('user-avatars/stable-1/abcdef.jpg')
	expect(parseUserAvatarCacheKey('user-avatars/stable-1/abcdef.webp')).toBe(
		'abcdef.webp',
	)
	expect(parseUserAvatarCacheKey('community-icon:v1/listing/asset')).toBeNull()
})

test('getUserAvatarObject refuses keys outside the user-avatars prefix', async () => {
	const gets: Array<string> = []
	const env = {
		COMMUNITY_ASSETS: {
			async get(key: string) {
				gets.push(key)
				return { key } as unknown as R2ObjectBody
			},
		},
	} as Pick<Env, 'COMMUNITY_ASSETS'>

	await expect(
		getUserAvatarObject({
			env,
			avatarKey: 'community-icon:v1/listing/asset',
		}),
	).resolves.toBeNull()
	expect(gets).toEqual([])

	await expect(
		getUserAvatarObject({
			env,
			avatarKey: 'user-avatars/stable-1/abcdef.png',
		}),
	).resolves.toEqual({ key: 'user-avatars/stable-1/abcdef.png' })
	expect(gets).toEqual(['user-avatars/stable-1/abcdef.png'])
})
