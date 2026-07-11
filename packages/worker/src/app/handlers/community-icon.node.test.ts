import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createCommunityIconHandler } from './community-icon.ts'
import { type CommunityListingRecord } from '#worker/community/types.ts'

const mocks = vi.hoisted(() => ({
	getCommunityIconObject: vi.fn(),
	getCommunityListingById: vi.fn(),
	renderCommunityIconFallbackPng: vi.fn(),
}))

vi.mock('#worker/community/community-icon.ts', () => {
	return {
		buildCommunityIconFallbackSvg: (name: string) =>
			`<svg xmlns="http://www.w3.org/2000/svg"><text>${name}</text></svg>`,
		getCommunityIconObject: (...args: Array<unknown>) =>
			mocks.getCommunityIconObject(...args),
		renderCommunityIconFallbackPng: (...args: Array<unknown>) =>
			mocks.renderCommunityIconFallbackPng(...args),
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
	iconCommit: 'def456',
	status: 'active',
	createdAt: '2026-07-10T00:00:00.000Z',
	updatedAt: '2026-07-10T00:00:00.000Z',
	publishedAt: '2026-07-10T00:00:00.000Z',
} satisfies CommunityListingRecord

function callHandler(iconCommit = listing.iconCommit) {
	const handler = createCommunityIconHandler({ APP_DB: {} } as Env)
	return handler.handler({
		request: new Request(
			`https://example.com/community/${listing.id}/icon/${iconCommit}`,
		),
		params: { listingId: listing.id, iconCommit },
		url: new URL(
			`https://example.com/community/${listing.id}/icon/${iconCommit}`,
		),
	} as never)
}

test('community icon handler serves cached R2 bytes for the current icon commit', async () => {
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
	expect(mocks.getCommunityIconObject).toHaveBeenCalledWith(
		expect.objectContaining({ iconCommit: listing.iconCommit }),
	)
})

test('community icon handler keeps serving the pinned snapshot commit', async () => {
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

	const response = await callHandler(listing.pinnedCommit)
	expect(response.status).toBe(200)
	expect(mocks.getCommunityIconObject).toHaveBeenCalledWith(
		expect.objectContaining({ iconCommit: listing.pinnedCommit }),
	)
})

test('community icon handler rejects stale commit URLs and degrades to a safe fallback', async () => {
	consoleError.mockImplementation(() => {})
	mocks.getCommunityListingById.mockResolvedValue(listing)
	expect((await callHandler('old-commit')).status).toBe(404)

	mocks.getCommunityIconObject.mockRejectedValue(
		new Error('Artifacts unavailable'),
	)
	const fallbackPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
	mocks.renderCommunityIconFallbackPng.mockResolvedValue(fallbackPng)
	const response = await callHandler()
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe('image/png')
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(response.headers.get('Content-Length')).toBe(
		String(fallbackPng.byteLength),
	)
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(fallbackPng)

	mocks.renderCommunityIconFallbackPng.mockRejectedValue(
		new Error('Renderer unavailable'),
	)
	const lastResortResponse = await callHandler()
	expect(lastResortResponse.headers.get('Content-Type')).toBe(
		'image/svg+xml; charset=utf-8',
	)
	expect(lastResortResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(await lastResortResponse.text()).toContain('<svg')
	expect(consoleError).toHaveBeenCalledWith(
		'community-icon-load-failed',
		listing.id,
		expect.any(Error),
	)
	expect(consoleError).toHaveBeenCalledWith(
		'community-icon-fallback-render-failed',
		listing.id,
		expect.any(Error),
	)
})
