import { expect, test, vi } from 'vitest'
import { createCommunityIconHandler } from './community-icon.ts'
import { type CommunityListingRecord } from '#worker/community/types.ts'

const mocks = vi.hoisted(() => ({
	getCommunityIconObject: vi.fn(),
	getCommunityListingById: vi.fn(),
}))

vi.mock('#worker/community/community-icon.ts', () => {
	return {
		buildCommunityIconFallbackSvg: (name: string) =>
			`<svg xmlns="http://www.w3.org/2000/svg"><text>${name}</text></svg>`,
		getCommunityIconObject: (...args: Array<unknown>) =>
			mocks.getCommunityIconObject(...args),
	}
})

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mocks.getCommunityListingById(...args),
}))

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

function callHandler(pinnedCommit = listing.pinnedCommit) {
	const handler = createCommunityIconHandler({ APP_DB: {} } as Env)
	return handler.handler({
		request: new Request(
			`https://example.com/community/${listing.id}/icon/${pinnedCommit}`,
		),
		params: { listingId: listing.id, pinnedCommit },
		url: new URL(
			`https://example.com/community/${listing.id}/icon/${pinnedCommit}`,
		),
	} as never)
}

test('community icon handler serves cached R2 bytes for the pinned listing', async () => {
	const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
	mocks.getCommunityListingById.mockResolvedValue(listing)
	mocks.getCommunityIconObject.mockResolvedValue({
		descriptor: {
			byteLength: bytes.byteLength,
			contentType: 'image/png',
		},
		object: {
			body: new Blob([bytes]).stream(),
			httpEtag: '"icon-etag"',
		},
	})

	const response = await callHandler()
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe('image/png')
	expect(response.headers.get('ETag')).toBe('"icon-etag"')
	expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
})

test('community icon handler rejects stale commit URLs and degrades to a safe fallback', async () => {
	mocks.getCommunityListingById.mockResolvedValue(listing)
	expect((await callHandler('old-commit')).status).toBe(404)

	mocks.getCommunityIconObject.mockRejectedValue(
		new Error('Artifacts unavailable'),
	)
	const response = await callHandler()
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe(
		'image/svg+xml; charset=utf-8',
	)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(await response.text()).toContain('<svg')
})
