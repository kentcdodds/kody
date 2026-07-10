import { expect, test, vi } from 'vitest'
import {
	findCommunityIconPath,
	getCommunityIconObject,
	processCommunityIcon,
} from './community-icon.ts'
import { type CommunityListingRecord } from './types.ts'

const mocks = vi.hoisted(() => ({
	readArtifactFileAtCommit: vi.fn(),
	getEntitySourceById: vi.fn(),
	getCommunityListingById: vi.fn(),
	readCommunitySnapshot: vi.fn(),
}))

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactFileAtCommit: (...args: Array<unknown>) =>
		mocks.readArtifactFileAtCommit(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mocks.getEntitySourceById(...args),
}))

vi.mock('./repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mocks.getCommunityListingById(...args),
}))

vi.mock('./snapshot.ts', () => ({
	readCommunitySnapshot: (...args: Array<unknown>) =>
		mocks.readCommunitySnapshot(...args),
}))

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

function createFakeKv() {
	const values = new Map<string, string>()
	return {
		values,
		kv: {
			async get(key: string, type?: string) {
				const value = values.get(key)
				if (value == null) return null
				return type === 'json' ? JSON.parse(value) : value
			},
			async put(key: string, value: string) {
				values.set(key, value)
			},
			async delete(key: string) {
				values.delete(key)
			},
		} as unknown as KVNamespace,
	}
}

function createFakeR2() {
	const values = new Map<string, Uint8Array>()
	const bucket = {
		async put(key: string, value: Uint8Array) {
			values.set(key, value)
			return { key }
		},
		async get(key: string) {
			const value = values.get(key)
			if (!value) return null
			return {
				body: new Blob([value]).stream(),
				httpEtag: '"test-etag"',
			}
		},
		async delete(key: string) {
			values.delete(key)
		},
	} as unknown as R2Bucket
	return { bucket, values }
}

const listing = {
	id: 'listing-1',
	ownerUserId: 'owner-1',
	packageId: 'package-1',
	sourceId: 'source-1',
	kodyId: 'github-tools',
	name: '@kentcdodds/github-tools',
	description: 'GitHub tools',
	tags: [],
	searchText: null,
	readmeContent: null,
	license: 'MIT',
	pinnedCommit: 'abc123',
	status: 'active',
	createdAt: '2026-07-10T00:00:00.000Z',
	updatedAt: '2026-07-10T00:00:00.000Z',
	publishedAt: '2026-07-10T00:00:00.000Z',
} satisfies CommunityListingRecord

test('community raster icon formats are validated and preserved', async () => {
	const png = createPngHeader(256, 256)
	const webp = createWebpHeader(320, 180)
	const jpeg = createJpegHeader(640, 480)
	const svg = new TextEncoder().encode(
		'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#2563eb"/></svg>',
	)

	await expect(
		processCommunityIcon({
			path: 'community-icon.png',
			sourceBytes: png,
		}),
	).resolves.toEqual({ bytes: png, contentType: 'image/png' })
	await expect(
		processCommunityIcon({
			path: 'community-icon.webp',
			sourceBytes: webp,
		}),
	).resolves.toEqual({ bytes: webp, contentType: 'image/webp' })
	await expect(
		processCommunityIcon({
			path: 'community-icon.jpeg',
			sourceBytes: jpeg,
		}),
	).resolves.toEqual({ bytes: jpeg, contentType: 'image/jpeg' })
	await expect(
		processCommunityIcon({
			path: 'community-icon.png',
			sourceBytes: createPngHeader(5000, 100),
		}),
	).rejects.toThrow('at most 4096px')
	const renderedSvg = await processCommunityIcon({
		path: 'community-icon.svg',
		sourceBytes: svg,
	})
	expect(renderedSvg.contentType).toBe('image/png')
	expect(Array.from(renderedSvg.bytes.slice(0, 4))).toEqual([
		0x89, 0x50, 0x4e, 0x47,
	])
	await expect(
		processCommunityIcon({
			path: 'community-icon.svg',
			sourceBytes: new TextEncoder().encode(
				'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			),
		}),
	).rejects.toThrow('active external content')
})

test('community icon descriptor caches the R2 reference and repairs a dangling reference', async () => {
	const png = createPngHeader(128, 128)
	const { kv, values: kvValues } = createFakeKv()
	const { bucket, values } = createFakeR2()
	const env = {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: kv,
		COMMUNITY_ASSETS: bucket,
	} as Env
	mocks.readCommunitySnapshot.mockResolvedValue({
		version: 1,
		listingId: listing.id,
		pinnedCommit: listing.pinnedCommit,
		files: {},
		communityIconPath: 'community-icon.png',
		createdAt: '2026-07-10T00:00:00.000Z',
	})
	mocks.getEntitySourceById.mockResolvedValue({
		id: listing.sourceId,
		user_id: listing.ownerUserId,
		entity_kind: 'package',
		entity_id: listing.packageId,
		repo_id: 'package-package-1',
		published_commit: listing.pinnedCommit,
		indexed_commit: listing.pinnedCommit,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		created_at: '2026-07-10T00:00:00.000Z',
		updated_at: '2026-07-10T00:00:00.000Z',
	})
	mocks.getCommunityListingById.mockResolvedValue(listing)
	mocks.readArtifactFileAtCommit.mockResolvedValue(png)

	const first = await getCommunityIconObject({ env, listing })
	const second = await getCommunityIconObject({ env, listing })
	expect(first.descriptor.contentType).toBe('image/png')
	expect(second.descriptor.r2Key).toBe(first.descriptor.r2Key)
	expect(mocks.readArtifactFileAtCommit).toHaveBeenCalledTimes(1)

	values.delete(first.descriptor.r2Key)
	const repaired = await getCommunityIconObject({ env, listing })
	expect(repaired.descriptor.r2Key).toBe(first.descriptor.r2Key)
	expect(mocks.readArtifactFileAtCommit).toHaveBeenCalledTimes(2)

	values.clear()
	kvValues.clear()
	mocks.getCommunityListingById.mockReset()
	mocks.getCommunityListingById
		.mockResolvedValueOnce(listing)
		.mockResolvedValueOnce(null)
	await getCommunityIconObject({ env, listing })
	expect(kvValues.size).toBe(0)
})

test('community icon path selection is deterministic', () => {
	expect(
		findCommunityIconPath({
			'community-icon.jpeg': '',
			'community-icon.svg': '',
		}),
	).toBe('community-icon.svg')
	expect(findCommunityIconPath({ 'package.json': '{}' })).toBeNull()
})
