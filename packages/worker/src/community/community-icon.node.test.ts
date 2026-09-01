import { expect, test, vi } from 'vitest'
import {
	getCommunityPublicCacheVersion,
	resetDataCacheForTests,
} from '#app/data-cache.ts'
import {
	communityIconPaths,
	deleteCommunityIconAssets,
	findCommunityIconPath,
	getCommunityIconObject,
	processCommunityIcon,
	refreshCommunityIconForPackagePublish,
	renderCommunityIconFallbackPng,
} from './community-icon.ts'
import { type CommunityListingRecord } from './types.ts'
import {
	createFakeImagesBinding,
	tinyWebpBytes,
} from '#worker/test-support/images-binding.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

const mocks = vi.hoisted(() => ({
	readFirstArtifactFileAtCommit: vi.fn(),
	getEntitySourceById: vi.fn(),
	getCommunityListingById: vi.fn(),
	getCommunityListingByOwnerAndPackage: vi.fn(),
	readCommunitySnapshot: vi.fn(),
}))

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readFirstArtifactFileAtCommit: (...args: Array<unknown>) =>
		mocks.readFirstArtifactFileAtCommit(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mocks.getEntitySourceById(...args),
}))

vi.mock('./repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mocks.getCommunityListingById(...args),
	getCommunityListingByOwnerAndPackage: (...args: Array<unknown>) =>
		mocks.getCommunityListingByOwnerAndPackage(...args),
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
			async list(options?: { prefix?: string }) {
				return {
					keys: Array.from(values.keys())
						.filter((name) => name.startsWith(options?.prefix ?? ''))
						.map((name) => ({ name })),
					list_complete: true,
				}
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
		async list(options?: { prefix?: string }) {
			return {
				objects: Array.from(values.keys())
					.filter((key) => key.startsWith(options?.prefix ?? ''))
					.map((key) => ({ key })),
				truncated: false,
			}
		},
	} as unknown as R2Bucket
	return { bucket, values }
}

function createCommunityIconTestEnv(input: {
	db: D1Database
	kv: KVNamespace
	bucket: R2Bucket
	meter?: ReturnType<typeof createInMemoryUserMeterEnv>
}) {
	const meter = input.meter ?? createInMemoryUserMeterEnv()
	return {
		APP_DB: input.db,
		BUNDLE_ARTIFACTS_KV: input.kv,
		COMMUNITY_ASSETS: input.bucket,
		IMAGES: createFakeImagesBinding(),
		USER_METER: meter.env.USER_METER,
	} as Env
}

function createCommunityIconDeletionRaceDbMock() {
	let deleting = false
	// After mirror retirement, the DO-authority path no longer calls DB batch for
	// lease acquire/release. We simulate the account-deletion race by counting
	// SELECT deleting_at queries: the first two are from the icon-generation
	// withAccountWriteLease flow; from the third onward we report deletion so that
	// isServableIconCommit (called by cache.set after icon creation) returns false
	// and skips the KV write.
	let deletingAtSelectCount = 0
	const db = {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim()
			return {
				bind() {
					return {
						async first<T>() {
							if (normalized.includes('SELECT deleting_at')) {
								deletingAtSelectCount++
								if (deletingAtSelectCount >= 3) deleting = true
								return { deleting_at: deleting ? 'now' : null } as T
							}
							return null
						},
						async run() {
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
	return { db }
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
	category: 'integrations',
	searchText: null,
	readmeContent: null,
	license: 'MIT',
	pinnedCommit: 'abc123',
	iconCommit: 'abc123',
	status: 'active',
	trustedCommit: null,
	trustedAt: null,
	trusted: false,
	featuredAt: null,
	featured: false,
	createdAt: '2026-07-10T00:00:00.000Z',
	updatedAt: '2026-07-10T00:00:00.000Z',
	publishedAt: '2026-07-10T00:00:00.000Z',
} satisfies CommunityListingRecord

const entitySourceRow = {
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
	external_check_until: null,
	created_at: '2026-07-10T00:00:00.000Z',
	updated_at: '2026-07-10T00:00:00.000Z',
}

test('community raster icon formats are validated then fitted to WebP', async () => {
	const png = createPngHeader(256, 256)
	const svg = new TextEncoder().encode(
		'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#2563eb"/></svg>',
	)
	const fitted = { bytes: tinyWebpBytes, contentType: 'image/webp' as const }

	await expect(
		processCommunityIcon({
			path: 'community-icon.png',
			sourceBytes: png,
			images: createFakeImagesBinding(),
		}),
	).resolves.toEqual(fitted)
	await expect(
		processCommunityIcon({
			path: 'community-icon.png',
			sourceBytes: createPngHeader(5000, 100),
			images: createFakeImagesBinding(),
		}),
	).rejects.toThrow('at most 4096px')
	await expect(
		processCommunityIcon({
			path: 'community-icon.svg',
			sourceBytes: svg,
			images: createFakeImagesBinding(),
		}),
	).resolves.toEqual(fitted)
	const fallbackPng = await renderCommunityIconFallbackPng(
		'@kentcdodds/github-tools',
	)
	expect(Array.from(fallbackPng.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
	await expect(
		processCommunityIcon({
			path: 'community-icon.svg',
			sourceBytes: new TextEncoder().encode(
				'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			),
			images: createFakeImagesBinding(),
		}),
	).rejects.toThrow('active external content')
	expect(
		findCommunityIconPath({
			'community-icon.jpeg': '',
			'community-icon.svg': '',
		}),
	).toBe('community-icon.svg')
	expect(findCommunityIconPath({ 'package.json': '{}' })).toBeNull()
})

test('community SVG icons load directly from the retained listing snapshot', async () => {
	const { kv } = createFakeKv()
	const { bucket } = createFakeR2()
	const env = {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: kv,
		COMMUNITY_ASSETS: bucket,
		IMAGES: createFakeImagesBinding(),
	} as Env
	mocks.readCommunitySnapshot.mockResolvedValue({
		version: 1,
		listingId: listing.id,
		pinnedCommit: listing.pinnedCommit,
		files: {
			'community-icon.svg':
				'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#2563eb"/></svg>',
		},
		communityIconPath: 'community-icon.svg',
		createdAt: '2026-07-10T00:00:00.000Z',
	})
	mocks.getCommunityListingById.mockResolvedValue(listing)

	const result = await getCommunityIconObject({
		env,
		listing,
		iconCommit: listing.pinnedCommit,
	})

	expect(result.descriptor.sourcePath).toBe('community-icon.svg')
	expect(result.descriptor.contentType).toBe('image/webp')
	expect(
		new Uint8Array(await new Response(result.object.body).arrayBuffer()),
	).toEqual(tinyWebpBytes)
	expect(mocks.getEntitySourceById).not.toHaveBeenCalled()
	expect(mocks.readFirstArtifactFileAtCommit).not.toHaveBeenCalled()
})

test('community icon descriptor caches the R2 reference and repairs a dangling reference', async () => {
	const png = createPngHeader(128, 128)
	const { kv, values: kvValues } = createFakeKv()
	const { bucket, values } = createFakeR2()
	const env = {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: kv,
		COMMUNITY_ASSETS: bucket,
		IMAGES: createFakeImagesBinding(),
	} as Env
	mocks.readCommunitySnapshot.mockResolvedValue({
		version: 1,
		listingId: listing.id,
		pinnedCommit: listing.pinnedCommit,
		files: {},
		communityIconPath: 'community-icon.png',
		createdAt: '2026-07-10T00:00:00.000Z',
	})
	mocks.getEntitySourceById.mockResolvedValue(entitySourceRow)
	mocks.getCommunityListingById.mockResolvedValue(listing)
	mocks.readFirstArtifactFileAtCommit.mockResolvedValue({
		path: 'community-icon.png',
		bytes: png,
	})

	const first = await getCommunityIconObject({
		env,
		listing,
		iconCommit: listing.pinnedCommit,
	})
	const second = await getCommunityIconObject({
		env,
		listing,
		iconCommit: listing.pinnedCommit,
	})
	expect(first.descriptor.contentType).toBe('image/webp')
	expect(second.descriptor.r2Key).toBe(first.descriptor.r2Key)
	expect(mocks.readFirstArtifactFileAtCommit).toHaveBeenCalledTimes(1)

	values.delete(first.descriptor.r2Key)
	const repaired = await getCommunityIconObject({
		env,
		listing,
		iconCommit: listing.pinnedCommit,
	})
	expect(repaired.descriptor.r2Key).toBe(first.descriptor.r2Key)
	expect(mocks.readFirstArtifactFileAtCommit).toHaveBeenCalledTimes(2)

	values.clear()
	kvValues.clear()
	mocks.getCommunityListingById.mockReset()
	mocks.getCommunityListingById
		.mockResolvedValueOnce(listing)
		.mockResolvedValueOnce(null)
	await getCommunityIconObject({
		env,
		listing,
		iconCommit: listing.pinnedCommit,
	})
	expect(kvValues.size).toBe(0)
})

test('community icon cache write loses the race to account deletion', async () => {
	const png = createPngHeader(128, 128)
	const { kv, values: kvValues } = createFakeKv()
	const { bucket } = createFakeR2()
	const { db } = createCommunityIconDeletionRaceDbMock()
	mocks.readCommunitySnapshot.mockResolvedValue({
		version: 1,
		listingId: listing.id,
		pinnedCommit: listing.pinnedCommit,
		files: {},
		communityIconPath: 'community-icon.png',
		createdAt: '2026-07-10T00:00:00.000Z',
	})
	mocks.getEntitySourceById.mockResolvedValue(entitySourceRow)
	mocks.getCommunityListingById.mockResolvedValue(listing)
	mocks.readFirstArtifactFileAtCommit.mockResolvedValue({
		path: 'community-icon.png',
		bytes: png,
	})
	await getCommunityIconObject({
		env: createCommunityIconTestEnv({ db, kv, bucket }),
		listing,
		iconCommit: listing.pinnedCommit,
	})
	// After mirror retirement, DB batch calls are no longer used for DO-authority
	// lease acquire/release. The deletion race is now detected via the D1
	// deleting_at point gate: isServableIconCommit sees deleting_at set (on its
	// third SELECT query, after icon generation completes) and skips the KV write.
	expect(kvValues.size).toBe(0)
})

test('community icons ahead of the pinned snapshot load from the artifact repo at the icon commit', async () => {
	const png = createPngHeader(128, 128)
	const iconCommit = 'def456'
	const publishedListing = { ...listing, iconCommit }
	const { kv } = createFakeKv()
	const { bucket } = createFakeR2()
	const env = {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: kv,
		COMMUNITY_ASSETS: bucket,
		IMAGES: createFakeImagesBinding(),
	} as Env
	mocks.readCommunitySnapshot.mockResolvedValue(null)
	mocks.getEntitySourceById.mockResolvedValue({
		...entitySourceRow,
		published_commit: iconCommit,
	})
	mocks.getCommunityListingById.mockResolvedValue(publishedListing)
	mocks.readFirstArtifactFileAtCommit.mockResolvedValue({
		path: 'community-icon.png',
		bytes: png,
	})

	const result = await getCommunityIconObject({
		env,
		listing: publishedListing,
		iconCommit,
	})

	expect(result.descriptor.iconCommit).toBe(iconCommit)
	expect(result.descriptor.r2Key).toContain(`/${iconCommit}/`)
	expect(result.descriptor.sourcePath).toBe('community-icon.png')
	expect(mocks.readFirstArtifactFileAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({
			commit: iconCommit,
			filePaths: [...communityIconPaths],
		}),
	)
	// The pinned snapshot is never consulted for ahead-of-snapshot commits.
	expect(mocks.readCommunitySnapshot).not.toHaveBeenCalled()
})

test('deleteCommunityIconAssets removes superseded revisions and keeps servable commits', async () => {
	const { kv, values: kvValues } = createFakeKv()
	const { bucket, values: r2Values } = createFakeR2()
	const kvKeyV1 = (listingId: string, commit: string) =>
		`derived-cache:v1:community-icon:v1:${listingId}:${commit}`
	const kvKeyV2 = (listingId: string, commit: string) =>
		`derived-cache:v1:community-icon:v2:${listingId}:${commit}`
	const kvKeyV3 = (listingId: string, commit: string) =>
		`derived-cache:v1:community-icon:v3:${listingId}:${commit}`
	const r2KeyV1 = (listingId: string, commit: string) =>
		`community-icon:v1/${listingId}/${commit}/asset`
	const r2KeyV2 = (listingId: string, commit: string) =>
		`community-icon:v2/${listingId}/${commit}/asset`
	const r2KeyV3 = (listingId: string, commit: string) =>
		`community-icon:v3/${listingId}/${commit}/asset`
	for (const commit of ['commit-1', 'commit-2', 'commit-3']) {
		kvValues.set(kvKeyV1(listing.id, commit), '{}')
		kvValues.set(kvKeyV2(listing.id, commit), '{}')
		kvValues.set(kvKeyV3(listing.id, commit), '{}')
		r2Values.set(r2KeyV1(listing.id, commit), Uint8Array.from([1]))
		r2Values.set(r2KeyV2(listing.id, commit), Uint8Array.from([1]))
		r2Values.set(r2KeyV3(listing.id, commit), Uint8Array.from([1]))
	}
	kvValues.set(kvKeyV1('other-listing', 'commit-1'), '{}')
	kvValues.set(kvKeyV2('other-listing', 'commit-1'), '{}')
	r2Values.set(r2KeyV1('other-listing', 'commit-1'), Uint8Array.from([1]))
	r2Values.set(r2KeyV2('other-listing', 'commit-1'), Uint8Array.from([1]))

	await deleteCommunityIconAssets({
		env: { BUNDLE_ARTIFACTS_KV: kv, COMMUNITY_ASSETS: bucket },
		listingId: listing.id,
		keepCommits: ['commit-2'],
	})

	expect(Array.from(kvValues.keys()).sort()).toEqual(
		[
			kvKeyV3(listing.id, 'commit-2'),
			kvKeyV1('other-listing', 'commit-1'),
			kvKeyV2('other-listing', 'commit-1'),
		].sort(),
	)
	expect(Array.from(r2Values.keys()).sort()).toEqual(
		[
			r2KeyV3(listing.id, 'commit-2'),
			r2KeyV1('other-listing', 'commit-1'),
			r2KeyV2('other-listing', 'commit-1'),
		].sort(),
	)
})

test('refreshCommunityIconForPackagePublish drops superseded icon caches for active listings', async () => {
	resetDataCacheForTests()
	const { kv, values: kvValues } = createFakeKv()
	const { bucket, values: r2Values } = createFakeR2()
	const env = {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: kv,
		COMMUNITY_ASSETS: bucket,
		IMAGES: createFakeImagesBinding(),
	} as Env
	const kvKeyV1 = (commit: string) =>
		`derived-cache:v1:community-icon:v1:${listing.id}:${commit}`
	const kvKeyV2 = (commit: string) =>
		`derived-cache:v1:community-icon:v2:${listing.id}:${commit}`
	const kvKeyV3 = (commit: string) =>
		`derived-cache:v1:community-icon:v3:${listing.id}:${commit}`
	const r2KeyV1 = (commit: string) =>
		`community-icon:v1/${listing.id}/${commit}/asset`
	const r2KeyV2 = (commit: string) =>
		`community-icon:v2/${listing.id}/${commit}/asset`
	const r2KeyV3 = (commit: string) =>
		`community-icon:v3/${listing.id}/${commit}/asset`
	for (const commit of [listing.pinnedCommit, 'old-publish', 'new-publish']) {
		kvValues.set(kvKeyV1(commit), '{}')
		kvValues.set(kvKeyV2(commit), '{}')
		kvValues.set(kvKeyV3(commit), '{}')
		r2Values.set(r2KeyV1(commit), Uint8Array.from([1]))
		r2Values.set(r2KeyV2(commit), Uint8Array.from([1]))
		r2Values.set(r2KeyV3(commit), Uint8Array.from([1]))
	}

	mocks.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		...listing,
		iconCommit: 'new-publish',
	})
	await refreshCommunityIconForPackagePublish({
		env,
		userId: listing.ownerUserId,
		packageId: listing.packageId,
		publishedCommit: 'new-publish',
	})

	expect(Array.from(kvValues.keys()).sort()).toEqual(
		[kvKeyV3(listing.pinnedCommit), kvKeyV3('new-publish')].sort(),
	)
	expect(Array.from(r2Values.keys()).sort()).toEqual(
		[r2KeyV3(listing.pinnedCommit), r2KeyV3('new-publish')].sort(),
	)
	expect(getCommunityPublicCacheVersion()).toBe(1)

	// Without an active listing the hook must be a no-op.
	mocks.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)
	r2Values.set(r2KeyV2('old-publish'), Uint8Array.from([1]))
	await refreshCommunityIconForPackagePublish({
		env,
		userId: listing.ownerUserId,
		packageId: listing.packageId,
		publishedCommit: 'newest-publish',
	})
	expect(r2Values.has(r2KeyV2('old-publish'))).toBe(true)
	expect(getCommunityPublicCacheVersion()).toBe(1)
	resetDataCacheForTests()
})
