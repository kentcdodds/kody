import { expect, test, vi } from 'vitest'
import { resetDataCacheForTests } from './data-cache.ts'
import {
	loadCommunityIndexData,
	loadOnboardingFeaturedListings,
} from './community-data.ts'
import {
	buildExistingAdaptPrompt,
	buildExistingInstallPrompt,
} from './community-public.ts'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
	listFeaturedCommunityListingsWithAggregates: vi.fn(),
	listCommunityForksByListingIdsAndUser: vi.fn(),
	listSavedPackagesByKodyIds: vi.fn(),
	listSavedPackagesByIds: vi.fn(),
	getMcpUserPackageScope: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityListingsWithAggregates: (...args: Array<unknown>) =>
		mockModule.listCommunityListingsWithAggregates(...args),
	searchCommunityListings: (...args: Array<unknown>) =>
		mockModule.searchCommunityListings(...args),
	listFeaturedCommunityListingsWithAggregates: (...args: Array<unknown>) =>
		mockModule.listFeaturedCommunityListingsWithAggregates(...args),
	getCommunityListingWithAggregates: vi.fn(),
}))

vi.mock('#worker/community/repo.ts', () => ({
	listCommunityForksByListingIdsAndUser: (...args: Array<unknown>) =>
		mockModule.listCommunityForksByListingIdsAndUser(...args),
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
	starCount: 0,
} satisfies CommunityListingWithAggregates

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
	mockModule.listCommunityListingsWithAggregates.mockResolvedValue([
		sampleListing,
	])
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
	expect(data.listings[0]?.viewerInstall).toEqual({
		status: 'installed',
		targetName: '@burhan/github',
		agentPrompt: buildExistingInstallPrompt({ targetName: '@burhan/github' }),
	})
	expect(mockModule.listSavedPackagesByKodyIds).toHaveBeenCalledWith(
		undefined,
		expect.objectContaining({ userId: 'viewer-1' }),
	)
	expect(mockModule.listCommunityForksByListingIdsAndUser).toHaveBeenCalledWith(
		undefined,
		expect.objectContaining({ userId: 'viewer-1' }),
	)
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
	expect(listings[0]?.viewerInstall).toEqual({
		status: 'adaptation_required',
		targetName: '@burhan/github',
		agentPrompt: buildExistingAdaptPrompt({
			targetName: '@burhan/github',
			sourceId: 'src-inert',
		}),
	})
})

test('community index omits viewerInstall for anonymous viewers and auth failures', async () => {
	resetDataCacheForTests()
	mockModule.listSavedPackagesByKodyIds.mockReset()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.listCommunityListingsWithAggregates.mockResolvedValue([
		sampleListing,
	])

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
