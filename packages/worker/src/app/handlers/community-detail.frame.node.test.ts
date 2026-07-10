import { expect, test, vi } from 'vitest'
import { createCommunityDetailHandler } from './community-detail.tsx'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	getCommunityListingWithAggregates: vi.fn(),
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	getCommunityListingWithAggregates: (...args: Array<unknown>) =>
		mockModule.getCommunityListingWithAggregates(...args),
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
	reportCommunityListing: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
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

test('community detail handler returns bare detail frame HTML for target header', async () => {
	mockModule.getCommunityListingWithAggregates.mockResolvedValue(sampleListing)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)

	const handler = createCommunityDetailHandler(env)
	const response = await handler.handler({
		request: new Request('https://example.com/community/listing-1', {
			headers: { 'x-remix-target': 'community-detail' },
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1'),
	} as never)
	const html = await response.text()

	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(html).toContain('data-testid="community-detail-frame"')
	expect(html).toContain('@kentcdodds/github-triage')
	expect(html).toContain('data-testid="community-listing-icon-detail"')
	expect(html).toContain('/community/listing-1/icon/abc1234567890')
	expect(html).toContain('data-testid="community-detail-forks"')
	expect(html).not.toContain('<html')
})
