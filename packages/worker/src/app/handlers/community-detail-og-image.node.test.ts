import { expect, test, vi } from 'vitest'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'
import { createCommunityDetailOgImageHandler } from './community-detail.tsx'

const mocks = vi.hoisted(() => ({
	getCommunityIconObject: vi.fn(),
	getCommunityListingWithAggregates: vi.fn(),
	renderCommunityIconFallbackPng: vi.fn(),
	renderCommunityOgImage: vi.fn(),
}))

vi.mock('#worker/community/community-icon.ts', () => ({
	getCommunityIconObject: (...args: Array<unknown>) =>
		mocks.getCommunityIconObject(...args),
	renderCommunityIconFallbackPng: (...args: Array<unknown>) =>
		mocks.renderCommunityIconFallbackPng(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	getCommunityListingWithAggregates: (...args: Array<unknown>) =>
		mocks.getCommunityListingWithAggregates(...args),
	reportCommunityListing: vi.fn(),
}))

vi.mock('#worker/community/og-image.ts', () => ({
	renderCommunityOgImage: (...args: Array<unknown>) =>
		mocks.renderCommunityOgImage(...args),
}))

const listing = {
	id: 'listing-1',
	ownerUserId: 'owner-1',
	packageId: 'package-1',
	sourceId: 'source-1',
	kodyId: 'github-triage',
	name: '@kody/github-triage',
	description: 'triage GitHub issues',
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
	averageStars: 4.6,
	ratingCount: 12,
	averageAdaptationEffort: null,
	forkCount: 37,
} satisfies CommunityListingWithAggregates

const tinyPng = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
	0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
	0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00,
	0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
	0x44, 0xae, 0x42, 0x60, 0x82,
])

test('community detail OG image embeds the package icon data URI', async () => {
	mocks.getCommunityListingWithAggregates.mockResolvedValue(listing)
	mocks.getCommunityIconObject.mockResolvedValue({
		descriptor: {
			version: 1,
			listingId: listing.id,
			iconCommit: listing.iconCommit,
			r2Key: 'community-icon:v1/listing-1/def456/asset',
			contentType: 'image/png',
			sourcePath: 'community-icon.png',
			byteLength: tinyPng.byteLength,
		},
		object: {
			arrayBuffer: async () => tinyPng.buffer.slice(0),
		},
	})
	mocks.renderCommunityOgImage.mockResolvedValue(tinyPng)

	const response = await createCommunityDetailOgImageHandler({} as Env).handler(
		{
			request: new Request('https://example.com/community/listing-1/og.png'),
			params: { listingId: listing.id },
			url: new URL('https://example.com/community/listing-1/og.png'),
		} as never,
	)

	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe('image/png')
	expect(mocks.renderCommunityOgImage).toHaveBeenCalledWith(
		expect.objectContaining({
			name: listing.name,
			iconDataUri: expect.stringMatching(/^data:image\/png;base64,/),
		}),
	)
	expect(mocks.renderCommunityIconFallbackPng).not.toHaveBeenCalled()
})

test('community detail OG image falls back when the icon is WebP', async () => {
	mocks.getCommunityListingWithAggregates.mockResolvedValue(listing)
	mocks.getCommunityIconObject.mockResolvedValue({
		descriptor: {
			version: 1,
			listingId: listing.id,
			iconCommit: listing.iconCommit,
			r2Key: 'community-icon:v1/listing-1/def456/asset',
			contentType: 'image/webp',
			sourcePath: 'community-icon.webp',
			byteLength: 12,
		},
		object: {
			arrayBuffer: async () => new ArrayBuffer(12),
		},
	})
	mocks.renderCommunityIconFallbackPng.mockResolvedValue(tinyPng)
	mocks.renderCommunityOgImage.mockResolvedValue(tinyPng)

	const response = await createCommunityDetailOgImageHandler({} as Env).handler(
		{
			request: new Request('https://example.com/community/listing-1/og.png'),
			params: { listingId: listing.id },
			url: new URL('https://example.com/community/listing-1/og.png'),
		} as never,
	)

	expect(response.status).toBe(200)
	expect(mocks.renderCommunityIconFallbackPng).toHaveBeenCalledWith(
		listing.name,
	)
	expect(mocks.renderCommunityOgImage).toHaveBeenCalledWith(
		expect.objectContaining({
			iconDataUri: expect.stringMatching(/^data:image\/png;base64,/),
		}),
	)
})
