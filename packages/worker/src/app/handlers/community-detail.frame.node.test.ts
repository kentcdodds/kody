import { expect, test, vi } from 'vitest'
import { createCommunityDetailHandler } from './community-detail.tsx'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	getCommunityListingWithAggregates: vi.fn(),
	readAuthenticatedAppUser: vi.fn(),
	getUserSocialRowByUsername: vi.fn(),
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

vi.mock('#worker/community/social-repo.ts', () => ({
	getCommunityStar: vi.fn().mockResolvedValue(false),
	getUserSocialRowByUsername: (...args: Array<unknown>) =>
		mockModule.getUserSocialRowByUsername(...args),
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
	trustedCommit: null,
	trustedAt: null,
	trusted: false,
	featuredAt: null,
	featured: false,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
	starCount: 0,
} satisfies CommunityListingWithAggregates

const env = {} as Env

test('community detail handler returns bare detail frame HTML for target header', async () => {
	mockModule.getCommunityListingWithAggregates.mockResolvedValue(sampleListing)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'public',
	})

	const handler = createCommunityDetailHandler(env)
	const publicResponse = await handler.handler({
		request: new Request('https://example.com/community/listing-1', {
			headers: { 'x-remix-target': 'community-detail' },
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1'),
	} as never)
	const publicHtml = await publicResponse.text()

	expect(publicResponse.status).toBe(200)
	expect(publicResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(publicHtml).toContain('data-testid="community-detail-frame"')
	expect(publicHtml).toContain('data-testid="community-listing-icon-detail"')
	expect(publicHtml).toContain('/community/listing-1/icon/abc1234567890')
	expect(publicHtml).toContain('href="/@kentcdodds"')
	expect(publicHtml).toContain('>@kentcdodds</a>')
	expect(publicHtml).not.toContain(
		'data-testid="community-detail-owner-private"',
	)
	expect(publicHtml).toContain('data-testid="community-detail-forks"')
	expect(publicHtml).not.toContain('<html')

	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'private',
	})
	const privateResponse = await handler.handler({
		request: new Request('https://example.com/community/listing-1', {
			headers: { 'x-remix-target': 'community-detail' },
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1'),
	} as never)
	const privateHtml = await privateResponse.text()
	expect(privateHtml).toContain('by @kentcdodds')
	expect(privateHtml).toContain('data-testid="community-detail-owner-private"')
	expect(privateHtml).toContain('title="This profile is private"')
	expect(privateHtml).not.toContain('href="/@kentcdodds"')
})
