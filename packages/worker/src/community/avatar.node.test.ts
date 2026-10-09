import { expect, test } from 'vitest'
import { buildUserAvatarUrl } from './public-urls.ts'
import {
	buildUserAvatarR2Key,
	getUserAvatarObject,
	parseUserAvatarCacheKey,
	processUserAvatar,
	saveUserAvatar,
	splitUserAvatarCacheKey,
} from './avatar.ts'
import { AccountDeletionInProgressError } from '#worker/account/deletion-state.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

function createAvatarDeletionRaceDbMock() {
	let deleting = false
	const db = {
		prepare(query: string) {
			return {
				bind() {
					return {
						async first<T>() {
							if (query.includes('SELECT deleting_at')) {
								return {
									deleting_at: deleting ? '2026-07-22 22:00:00' : null,
								} as T
							}
							if (query.includes('SELECT avatar_key')) {
								return { avatar_key: null } as T
							}
							return null
						},
						async run() {
							if (
								query.includes('UPDATE users') &&
								query.includes('avatar_key')
							) {
								return { meta: { changes: deleting ? 0 : 1 } }
							}
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
		async batch() {
			return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }]
		},
	} as unknown as D1Database
	return {
		db,
		setDeleting(value: boolean) {
			deleting = value
		},
	}
}

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
	// SOI + SOF0 (height/width at offsets 7 and 9) + EOI.
	const bytes = Uint8Array.from([
		0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x11,
		0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
	])
	new DataView(bytes.buffer).setUint16(7, height)
	new DataView(bytes.buffer).setUint16(9, width)
	return bytes
}

test('processUserAvatar accepts valid png/jpeg/webp and rejects unsafe inputs', () => {
	const png = createPngHeader(128, 128)
	const webp = createWebpHeader(320, 180)
	const jpeg = createJpegHeader(256, 256)
	const accepted: Array<
		[contentType: string, sourceBytes: Uint8Array, normalizedType: string]
	> = [
		['image/png', png, 'image/png'],
		['image/webp', webp, 'image/webp'],
		['image/jpeg', jpeg, 'image/jpeg'],
		['image/jpg', jpeg, 'image/jpeg'],
	]
	for (const [contentType, sourceBytes, normalizedType] of accepted) {
		expect(processUserAvatar({ contentType, sourceBytes })).toEqual({
			bytes: sourceBytes,
			contentType: normalizedType,
		})
	}

	const rejected: Array<
		[contentType: string, sourceBytes: Uint8Array, error: string]
	> = [
		[
			'image/svg+xml',
			new TextEncoder().encode('<svg></svg>'),
			'PNG, JPEG, or WebP',
		],
		['image/png', new Uint8Array(1_000_001), '1000000 bytes'],
		['image/png', createPngHeader(32, 32), 'between 64px and 4096px'],
		['image/png', createPngHeader(5000, 128), 'between 64px and 4096px'],
		['image/png', createPngHeader(640, 128), 'aspect ratio'],
	]
	for (const [contentType, sourceBytes, error] of rejected) {
		expect(() => processUserAvatar({ contentType, sourceBytes })).toThrow(error)
	}
})

test('buildUserAvatarR2Key and parseUserAvatarCacheKey round-trip content hash segment', () => {
	for (const [contentType, ext] of [
		['image/png', 'png'],
		['image/jpeg', 'jpg'],
	] as const) {
		expect(
			buildUserAvatarR2Key({
				stableUserId: 'stable-1',
				contentHash: 'abcdef',
				contentType,
			}),
		).toBe(`user-avatars/stable-1/abcdef.${ext}`)
	}
	expect(parseUserAvatarCacheKey('user-avatars/stable-1/abcdef.webp')).toBe(
		'abcdef.webp',
	)
	expect(parseUserAvatarCacheKey('community-icon:v1/listing/asset')).toBeNull()
	expect(splitUserAvatarCacheKey('abcdef.webp')).toEqual({
		hash: 'abcdef',
		ext: 'webp',
	})
	expect(splitUserAvatarCacheKey('abcdef')).toBeNull()
	expect(
		buildUserAvatarUrl({
			username: 'alice',
			avatarKey: 'user-avatars/stable-1/abcdef.jpg',
		}),
	).toBe('/profiles/alice/avatar/abcdef.jpg')
	expect(buildUserAvatarUrl({ username: 'alice', avatarKey: null })).toBeNull()
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
		getUserAvatarObject({ env, avatarKey: 'community-icon:v1/listing/asset' }),
	).resolves.toBeNull()
	expect(gets).toEqual([])

	const avatarKey = 'user-avatars/stable-1/abcdef.png'
	await expect(getUserAvatarObject({ env, avatarKey })).resolves.toEqual({
		key: avatarKey,
	})
	expect(gets).toEqual([avatarKey])
})

test('saveUserAvatar removes an in-flight upload when deletion starts', async () => {
	const putStarted = Promise.withResolvers<void>()
	const putReleased = Promise.withResolvers<void>()
	const deleted: Array<string> = []
	const { db, setDeleting } = createAvatarDeletionRaceDbMock()
	const save = saveUserAvatar({
		env: {
			APP_DB: db,
			COMMUNITY_ASSETS: {
				async put() {
					putStarted.resolve()
					await putReleased.promise
					return {} as R2Object
				},
				async delete(key: string) {
					deleted.push(key)
				},
			} as unknown as R2Bucket,
			USER_METER: createInMemoryUserMeterEnv().env.USER_METER,
		},
		numericUserId: 1,
		stableUserId: 'stable-1',
		bytes: createPngHeader(128, 128),
		contentType: 'image/png',
	})
	await putStarted.promise
	setDeleting(true)
	putReleased.resolve()
	await expect(save).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(deleted).toHaveLength(1)
	expect(deleted[0]).toMatch(/^user-avatars\/stable-1\//)
})
