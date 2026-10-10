import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createCommunityHandler } from './community.tsx'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	listCommunityIndexOverview: vi.fn(),
	getCommunityCategoryCounts: vi.fn(),
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
	readAuthenticatedAppUser: vi.fn(),
	listCommunityForksByListingIdsAndUser: vi.fn(),
	listSavedPackagesBySlugs: vi.fn(),
	listSavedPackagesByIds: vi.fn(),
	getMcpUserPackageScope: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityIndexOverview: (...args: Array<unknown>) =>
		mockModule.listCommunityIndexOverview(...args),
	getCommunityCategoryCounts: (...args: Array<unknown>) =>
		mockModule.getCommunityCategoryCounts(...args),
	listCommunityListingsWithAggregates: (...args: Array<unknown>) =>
		mockModule.listCommunityListingsWithAggregates(...args),
	searchCommunityListings: (...args: Array<unknown>) =>
		mockModule.searchCommunityListings(...args),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	listCommunityForksByListingIdsAndUser: (...args: Array<unknown>) =>
		mockModule.listCommunityForksByListingIdsAndUser(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesBySlugs: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesBySlugs(...args),
	listSavedPackagesByIds: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByIds(...args),
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getMcpUserPackageScope: (...args: Array<unknown>) =>
		mockModule.getMcpUserPackageScope(...args),
}))

const sampleListing = {
	id: 'listing-1',
	ownerUserId: ownerIdFromStored('owner-mcp-id'),
	packageId: 'pkg-1',
	sourceId: 'src-1',
	kodyId: 'github-triage',
	name: '@kentcdodds/github-triage',
	description: 'Triage GitHub issues.',
	tags: ['github'],
	category: 'integrations',
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
} satisfies CommunityListingWithAggregates

const env = {} as Env

test('community page handler returns bare listings frame HTML for target header', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.listCommunityIndexOverview.mockResolvedValue({
		listings: [sampleListing],
		groups: [
			{
				category: 'integrations',
				listings: [sampleListing],
				total: 1,
			},
		],
		categoryCounts: {
			integrations: 1,
			examples: 0,
			productivity: 0,
			apps: 0,
			utilities: 0,
			other: 0,
		},
	})

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
	expect(html).toContain('data-testid="community-listings-sort"')
	expect(html).toContain('data-testid="community-listing-published-listing-1"')
	expect(html).toContain('data-testid="community-listing-icon-card"')
	expect(html).toContain('/community/listing-1/icon/abc1234567890')
	expect(html).not.toContain('<html')
	expect(html).not.toContain(
		'data-testid="community-listing-viewer-install-listing-1"',
	)

	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: ownerIdFromStored('viewer-1'), username: 'burhan' },
		roles: [],
	})
	mockModule.getMcpUserPackageScope.mockResolvedValue('burhan')
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([])
	mockModule.listSavedPackagesBySlugs.mockResolvedValue([
		{
			id: 'pkg-github',
			kodyId: 'github-triage',
			name: '@burhan/github-triage',
			sourceId: 'src-github',
		},
	])
	mockModule.listSavedPackagesByIds.mockResolvedValue([])
	const sameLeafOnlyResponse = await handler.handler({
		request: new Request('https://example.com/community', {
			headers: { 'x-remix-target': 'community-listings' },
		}),
		params: {},
		url: new URL('https://example.com/community'),
	} as never)
	const sameLeafOnlyHtml = await sameLeafOnlyResponse.text()
	expect(sameLeafOnlyHtml).not.toContain(
		'data-testid="community-listing-viewer-install-listing-1"',
	)
	expect(sameLeafOnlyHtml).not.toContain('Installed')

	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([
		{
			listingId: 'listing-1',
			targetKodyId: 'github-triage',
			forkedPackageId: 'pkg-github',
			forkedSourceId: 'src-github',
			createdAt: '2026-08-01T00:00:00.000Z',
			originCommit: 'abc1234567890',
		},
	])
	const signedInResponse = await handler.handler({
		request: new Request('https://example.com/community', {
			headers: { 'x-remix-target': 'community-listings' },
		}),
		params: {},
		url: new URL('https://example.com/community'),
	} as never)
	const signedInHtml = await signedInResponse.text()
	expect(signedInHtml).toContain(
		'data-testid="community-listing-viewer-install-listing-1"',
	)
	const paramResponse = await handler.handler({
		request: new Request(
			'https://example.com/community?__frame=community-listings',
		),
		params: {},
		url: new URL('https://example.com/community?__frame=community-listings'),
	} as never)
	const paramHtml = await paramResponse.text()
	expect(paramResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(paramHtml).toContain('data-testid="community-listings-frame"')
	expect(paramHtml).not.toContain('<html')

	expect(signedInHtml).toContain('Installed')
	expect(
		signedInHtml.indexOf(
			'data-testid="community-listing-viewer-install-listing-1"',
		),
	).toBeGreaterThan(signedInHtml.indexOf('</h2>'))
})
