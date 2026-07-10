import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import {
	buildCommunityIconCacheKey,
	buildCommunityIconR2Key,
	getCommunityIconObject,
} from './community-icon.ts'
import { type CommunityListingRecord } from './types.ts'
import { derivedCacheKeyPrefix } from '#worker/kv-cachified.ts'

test('community icon resolves a cachified descriptor to R2 bytes', async () => {
	const listing = {
		id: `listing-${crypto.randomUUID()}`,
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
	const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
	const r2Key = buildCommunityIconR2Key({
		listingId: listing.id,
		pinnedCommit: listing.pinnedCommit,
	})
	const cacheKey =
		derivedCacheKeyPrefix +
		buildCommunityIconCacheKey({
			listingId: listing.id,
			pinnedCommit: listing.pinnedCommit,
		})
	await env.COMMUNITY_ASSETS.put(r2Key, bytes, {
		httpMetadata: { contentType: 'image/png' },
	})
	await env.BUNDLE_ARTIFACTS_KV.put(
		cacheKey,
		JSON.stringify({
			metadata: {
				createdTime: Date.now(),
				ttl: 30 * 24 * 60 * 60 * 1000,
			},
			value: {
				version: 1,
				listingId: listing.id,
				pinnedCommit: listing.pinnedCommit,
				r2Key,
				contentType: 'image/png',
				sourcePath: 'community-icon.png',
				byteLength: bytes.byteLength,
			},
		}),
	)

	const result = await getCommunityIconObject({
		env,
		listing,
	})

	expect(result.descriptor.r2Key).toBe(r2Key)
	expect(new Uint8Array(await result.object.arrayBuffer())).toEqual(bytes)
})
