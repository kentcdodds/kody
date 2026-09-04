import { expect, test, vi } from 'vitest'
import {
	emptyCommunityCategoryCounts,
	type CommunityCategoryCounts,
} from '#universal/community-categories.ts'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'
import { onboardingFeaturedMcpServers } from '#universal/onboarding-mcp-chooser.ts'
import { resetDataCacheForTests } from './data-cache.ts'
import {
	loadCommunityDetailData,
	loadCommunityIndexData,
	loadOnboardingFeaturedListings,
	loadOnboardingMcpChooserListings,
} from './community-data.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	listCommunityIndexOverview: vi.fn(),
	getCommunityCategoryCounts: vi.fn(),
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
	listFeaturedCommunityListingsWithAggregates: vi.fn(),
	getCommunityListingWithAggregates: vi.fn(),
	getCommunityListingsByIds: vi.fn(),
	listCommunityForksByListingIdsAndUser: vi.fn(),
	getCommunityListingById: vi.fn(),
	getEntitySourceById: vi.fn(),
	resolveCachedArtifactSourceHead: vi.fn(),
	listSavedPackagesByKodyIds: vi.fn(),
	listSavedPackagesByIds: vi.fn(),
	getMcpUserPackageScope: vi.fn(),
	getUserSocialRowByUsername: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
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
	listFeaturedCommunityListingsWithAggregates: (...args: Array<unknown>) =>
		mockModule.listFeaturedCommunityListingsWithAggregates(...args),
	getCommunityListingWithAggregates: (...args: Array<unknown>) =>
		mockModule.getCommunityListingWithAggregates(...args),
	getCommunityListingsByIds: (...args: Array<unknown>) =>
		mockModule.getCommunityListingsByIds(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mockModule.getCommunityListingById(...args),
	listCommunityForksByListingIdsAndUser: (...args: Array<unknown>) =>
		mockModule.listCommunityForksByListingIdsAndUser(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifact-head-cache.ts', () => ({
	resolveCachedArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveCachedArtifactSourceHead(...args),
}))

vi.mock('#worker/community/profile-repo.ts', () => ({
	getUserSocialRowByUsername: (...args: Array<unknown>) =>
		mockModule.getUserSocialRowByUsername(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByKodyIds: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByKodyIds(...args),
	listSavedPackagesByIds: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByIds(...args),
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getMcpUserPackageScope: (...args: Array<unknown>) =>
		mockModule.getMcpUserPackageScope(...args),
}))

const sampleListing = {
	id: 'listing-github',
	ownerUserId: 'owner-mcp-id',
	packageId: 'pkg-1',
	sourceId: 'src-1',
	kodyId: 'github',
	name: '@kody/github',
	description: 'GitHub helpers.',
	tags: ['github'],
	category: 'integrations',
	searchText: null,
	readmeContent: '# README',
	license: 'MIT',
	pinnedCommit: 'abc1234567890',
	iconCommit: 'abc1234567890',
	status: 'active',
	trustedCommit: 'abc1234567890',
	trustedAt: '2026-01-02T00:00:00.000Z',
	trusted: true,
	featuredAt: '2026-01-03T00:00:00.000Z',
	featured: true,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
} satisfies CommunityListingWithAggregates

function categoryCounts(
	overrides: Partial<CommunityCategoryCounts> = {},
): CommunityCategoryCounts {
	return { ...emptyCommunityCategoryCounts(), ...overrides }
}

function sampleOverview(listing = sampleListing) {
	return {
		listings: [listing],
		groups: [
			{
				category: listing.category,
				listings: [listing],
				total: 1,
			},
		],
		categoryCounts: categoryCounts({ [listing.category]: 1 }),
	}
}

function signedInUser() {
	return {
		mcpUser: { userId: 'viewer-1', username: 'burhan' },
		roles: [],
	}
}

test('community index overlays matching kody_id installs for signed-in viewers', async () => {
	resetDataCacheForTests()
	mockModule.listSavedPackagesByKodyIds.mockReset()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(signedInUser())
	mockModule.listCommunityIndexOverview.mockResolvedValue(sampleOverview())
	mockModule.getMcpUserPackageScope.mockResolvedValue('burhan')
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([])
	mockModule.listSavedPackagesByKodyIds.mockResolvedValue([
		{
			id: 'pkg-github',
			kodyId: 'github',
			name: '@burhan/github',
			sourceId: 'src-github',
		},
	])
	mockModule.listSavedPackagesByIds.mockResolvedValue([])

	const data = await loadCommunityIndexData(
		{} as Env,
		new Request('https://example.com/community'),
	)
	expect(data.listings).toHaveLength(1)
	expect(data.listings[0]?.viewerInstall).toEqual(
		expect.objectContaining({
			status: 'installed',
			targetName: '@burhan/github',
			packageId: 'pkg-github',
		}),
	)
	expect(mockModule.listSavedPackagesByKodyIds).toHaveBeenCalledWith(
		undefined,
		expect.objectContaining({ userId: 'viewer-1' }),
	)
	expect(mockModule.listCommunityForksByListingIdsAndUser).toHaveBeenCalledWith(
		undefined,
		expect.objectContaining({ userId: 'viewer-1' }),
	)
})

test('onboarding MCP chooser listings load official packages by pinned id', async () => {
	resetDataCacheForTests()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const pinnedIds = onboardingFeaturedMcpServers
		.map((server) => server.listingId)
		.filter((id) => id.length > 0)
	const visibleListing = {
		...sampleListing,
		id: onboardingFeaturedMcpServers[0].listingId,
		kodyId: 'notion-mcp',
		name: '@kody/notion-mcp',
	}
	mockModule.getCommunityListingsByIds.mockResolvedValue([visibleListing])

	const listings = await loadOnboardingMcpChooserListings(
		{} as Env,
		new Request('https://example.com/onboarding'),
	)
	expect(listings).toEqual([
		expect.objectContaining({
			id: onboardingFeaturedMcpServers[0].listingId,
			kodyId: 'notion-mcp',
			name: '@kody/notion-mcp',
		}),
	])
	expect(mockModule.getCommunityListingsByIds).toHaveBeenCalledTimes(1)
	expect(mockModule.getCommunityListingsByIds).toHaveBeenCalledWith(
		undefined,
		pinnedIds,
		{ includeDelisted: false },
	)

	const cached = await loadOnboardingMcpChooserListings(
		{} as Env,
		new Request('https://example.com/onboarding'),
	)
	expect(cached).toEqual(listings)
	expect(mockModule.getCommunityListingsByIds).toHaveBeenCalledTimes(1)
})

test('onboarding featured listings overlay inert forks as adaptation_required', async () => {
	resetDataCacheForTests()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(signedInUser())
	mockModule.listFeaturedCommunityListingsWithAggregates.mockResolvedValue([
		sampleListing,
	])
	mockModule.getMcpUserPackageScope.mockResolvedValue('burhan')
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([
		{
			listingId: 'listing-github',
			targetKodyId: 'github',
			forkedPackageId: 'pkg-inert',
			forkedSourceId: 'src-inert',
			createdAt: '2026-08-01T00:00:00.000Z',
		},
	])
	mockModule.listSavedPackagesByKodyIds.mockResolvedValue([])
	mockModule.listSavedPackagesByIds.mockResolvedValue([])

	const listings = await loadOnboardingFeaturedListings(
		{} as Env,
		new Request('https://example.com/onboarding'),
	)
	expect(listings).toHaveLength(1)
	expect(listings[0]?.viewerInstall).toEqual(
		expect.objectContaining({
			status: 'adaptation_required',
			targetName: '@burhan/github',
			packageId: null,
		}),
	)
})

test('community detail overlays viewerInstall for forked listings and omits it when not forked', async () => {
	resetDataCacheForTests()
	mockModule.getCommunityListingWithAggregates.mockResolvedValue(sampleListing)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing)
	mockModule.getEntitySourceById.mockResolvedValue(null)
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'public',
		stable_user_id: 'owner-mcp-id',
	})
	mockModule.getMcpUserPackageScope.mockResolvedValue('burhan')
	mockModule.listSavedPackagesByIds.mockResolvedValue([])

	mockModule.readAuthenticatedAppUser.mockResolvedValue(signedInUser())
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([])
	mockModule.listSavedPackagesByKodyIds.mockResolvedValue([])
	const notForked = await loadCommunityDetailData(
		{} as Env,
		new Request('https://example.com/community/listing-github'),
		'listing-github',
	)
	expect(notForked?.viewerInstall).toBeNull()

	resetDataCacheForTests()
	mockModule.getCommunityListingWithAggregates.mockResolvedValue(sampleListing)
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([
		{
			listingId: 'listing-github',
			targetKodyId: 'github',
			forkedPackageId: 'pkg-github',
			forkedSourceId: 'src-github',
			createdAt: '2026-08-01T00:00:00.000Z',
		},
	])
	mockModule.listSavedPackagesByKodyIds.mockResolvedValue([
		{
			id: 'pkg-github',
			kodyId: 'github',
			name: '@burhan/github',
			sourceId: 'src-github',
		},
	])
	const forked = await loadCommunityDetailData(
		{} as Env,
		new Request('https://example.com/community/listing-github-forked'),
		'listing-github',
	)
	expect(forked?.viewerInstall).toEqual(
		expect.objectContaining({
			status: 'installed',
			targetName: '@burhan/github',
			packageId: 'pkg-github',
		}),
	)
	expect(forked?.listing.viewerInstall?.status).toBe('installed')
	expect(forked?.viewerInstall?.listingAhead).toBe(false)

	resetDataCacheForTests()
	mockModule.getCommunityListingWithAggregates.mockResolvedValue({
		...sampleListing,
		pinnedCommit: 'commit-new',
	})
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([
		{
			listingId: 'listing-github',
			targetKodyId: 'github',
			forkedPackageId: 'pkg-github',
			forkedSourceId: 'src-github',
			createdAt: '2026-08-01T00:00:00.000Z',
			originCommit: 'abc1234567890',
		},
	])
	mockModule.listSavedPackagesByKodyIds.mockResolvedValue([
		{
			id: 'pkg-github',
			kodyId: 'github',
			name: '@burhan/github',
			sourceId: 'src-github',
		},
	])
	const ahead = await loadCommunityDetailData(
		{} as Env,
		new Request('https://example.com/community/listing-github-ahead'),
		'listing-github',
	)
	expect(ahead?.viewerInstall).toEqual(
		expect.objectContaining({
			status: 'installed',
			listingAhead: true,
		}),
	)
	expect(typeof ahead?.viewerInstall?.listingAheadPrompt).toBe('string')
	expect(ahead?.viewerInstall?.listingAheadPrompt?.length ?? 0).toBeGreaterThan(
		0,
	)
})

test('sourceAhead compares HEAD to the runtime pin, not the community catalog snapshot', async () => {
	resetDataCacheForTests()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.getCommunityListingWithAggregates.mockResolvedValue(sampleListing)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing)
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'public',
		stable_user_id: 'owner-mcp-id',
	})
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([])
	mockModule.listSavedPackagesByKodyIds.mockResolvedValue([])
	mockModule.listSavedPackagesByIds.mockResolvedValue([])
	mockModule.getMcpUserPackageScope.mockResolvedValue('viewer')
	const runtimePin = 'cccccccccccccccccccccccccccccccccccccccc'
	const unpublishedHead = 'dddddddddddddddddddddddddddddddddddddddd'
	mockModule.getEntitySourceById.mockResolvedValue({
		repo_id: 'repo-1',
		published_commit: runtimePin,
	})
	mockModule.resolveCachedArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: runtimePin,
	})

	const published = await loadCommunityDetailData(
		{} as Env,
		new Request('https://example.com/community/listing-github-published'),
		'listing-github',
	)
	expect(published?.listing.sourceAhead).toBeUndefined()
	expect(published?.listing.headCommit).toBeUndefined()
	expect(published?.listing.pinnedCommit).toBe(sampleListing.pinnedCommit)
	expect(published?.listing.pinnedCommit).not.toBe(runtimePin)

	resetDataCacheForTests()
	mockModule.resolveCachedArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: unpublishedHead,
	})
	const aheadOfRuntime = await loadCommunityDetailData(
		{} as Env,
		new Request('https://example.com/community/listing-github-runtime-ahead'),
		'listing-github',
	)
	expect(aheadOfRuntime?.listing.sourceAhead).toBe(true)
	expect(aheadOfRuntime?.listing.headCommit).toBe(unpublishedHead)
})

test('community index is memoized per request and forwards newest sort to loaders', async () => {
	resetDataCacheForTests()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.listCommunityIndexOverview.mockReset()
	mockModule.listCommunityListingsWithAggregates.mockReset()
	mockModule.searchCommunityListings.mockReset()
	mockModule.getCommunityCategoryCounts.mockReset()
	mockModule.listCommunityIndexOverview.mockResolvedValue(sampleOverview())
	mockModule.listCommunityListingsWithAggregates.mockResolvedValue([
		sampleListing,
	])
	mockModule.searchCommunityListings.mockResolvedValue([sampleListing])
	mockModule.getCommunityCategoryCounts.mockResolvedValue(
		categoryCounts({ integrations: 12, examples: 3 }),
	)

	const request = new Request('https://example.com/community')
	const first = loadCommunityIndexData({} as Env, request)
	const second = loadCommunityIndexData({} as Env, request)
	expect(second).toBe(first)
	expect((await first).listings).toHaveLength(1)
	expect((await first).category).toBeNull()
	expect((await first).groups?.[0]?.category).toBe('integrations')
	expect((await first).categoryCounts.integrations).toBe(1)
	expect((await first).categoryCounts.utilities).toBe(0)
	expect(await second).toBe(await first)
	expect(mockModule.listCommunityIndexOverview).toHaveBeenCalledTimes(1)
	expect((await first).sort).toBe('best')

	mockModule.listCommunityIndexOverview.mockClear()
	const newestBrowse = await loadCommunityIndexData(
		{} as Env,
		new Request('https://example.com/community?sort=newest'),
	)
	expect(newestBrowse.sort).toBe('newest')
	expect(mockModule.listCommunityIndexOverview).toHaveBeenCalledWith({
		env: {},
		sort: 'newest',
	})

	const newestSearch = await loadCommunityIndexData(
		{} as Env,
		new Request('https://example.com/community?q=github&sort=newest'),
	)
	expect(newestSearch.sort).toBe('newest')
	expect(newestSearch.query).toBe('github')
	expect(newestSearch.category).toBeNull()
	expect(newestSearch.groups).toBeNull()
	expect(newestSearch.categoryCounts.examples).toBe(3)
	expect(mockModule.searchCommunityListings).toHaveBeenCalledWith({
		env: {},
		query: 'github',
		limit: 50,
		sort: 'newest',
		category: null,
	})
	expect(mockModule.getCommunityCategoryCounts).toHaveBeenCalledWith({
		env: {},
	})

	mockModule.listCommunityListingsWithAggregates.mockClear()
	const integrationsBrowse = await loadCommunityIndexData(
		{} as Env,
		new Request('https://example.com/community?category=integrations'),
	)
	expect(integrationsBrowse.category).toBe('integrations')
	expect(integrationsBrowse.groups).toBeNull()
	expect(mockModule.listCommunityListingsWithAggregates).toHaveBeenCalledWith({
		env: {},
		includeDelisted: false,
		limit: 50,
		offset: 0,
		sort: 'best',
		category: 'integrations',
	})
})

test('community index omits viewerInstall for anonymous viewers and auth failures', async () => {
	resetDataCacheForTests()
	mockModule.listSavedPackagesByKodyIds.mockReset()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.listCommunityIndexOverview.mockResolvedValue(sampleOverview())

	const anonymous = await loadCommunityIndexData(
		{} as Env,
		new Request('https://example.com/community'),
	)
	expect(anonymous.listings[0]?.viewerInstall).toBeUndefined()
	expect(mockModule.listSavedPackagesByKodyIds).not.toHaveBeenCalled()

	mockModule.listSavedPackagesByKodyIds.mockReset()
	mockModule.readAuthenticatedAppUser.mockRejectedValue(
		new Error('Missing COOKIE_SECRET for session signing.'),
	)
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

	const failedAuth = await loadCommunityIndexData(
		{} as Env,
		new Request('https://example.com/community'),
	)
	expect(failedAuth.ok).toBe(true)
	expect(failedAuth.listings).toHaveLength(1)
	expect(failedAuth.listings[0]?.id).toBe('listing-github')
	expect(failedAuth.listings[0]?.viewerInstall).toBeUndefined()
	expect(mockModule.listSavedPackagesByKodyIds).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalled()
	consoleError.mockRestore()
})
