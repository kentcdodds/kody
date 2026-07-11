import { expect, test, vi } from 'vitest'
import { createCommunityHandler } from './community.tsx'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityListingsWithAggregates: (...args: Array<unknown>) =>
		mockModule.listCommunityListingsWithAggregates(...args),
	searchCommunityListings: (...args: Array<unknown>) =>
		mockModule.searchCommunityListings(...args),
}))

const sampleListing = {
	id: 'listing-1',
	ownerUserId: 'owner-mcp-id',
	packageId: 'pkg-1',
	sourceId: 'src-1',
	kodyId: 'github-triage',
	name: '@kentcdodds/github-triage',
	description: 'Triage GitHub issues.',
	tags: ['github'],
	searchText: null,
	readmeContent: '# README',
	license: 'MIT',
	pinnedCommit: 'abc1234567890',
	iconCommit: 'abc1234567890',
	status: 'active',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
} satisfies CommunityListingWithAggregates

const env = {} as Env

test('community page handler returns bare listings frame HTML for target header', async () => {
	mockModule.listCommunityListingsWithAggregates.mockResolvedValue([
		sampleListing,
	])

	const handler = createCommunityHandler(env)
	const response = await handler.handler({
		request: new Request('https://example.com/community', {
			headers: { 'x-remix-target': 'community-listings' },
		}),
		params: {},
		url: new URL('https://example.com/community'),
	} as never)
	const html = await response.text()

	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(html).toContain('data-testid="community-listings-frame"')
	expect(html).toContain('@kentcdodds/github-triage')
	expect(html).toContain('data-testid="community-listing-icon-card"')
	expect(html).toContain('/community/listing-1/icon/abc1234567890')
	expect(html).not.toContain('<html')
})
