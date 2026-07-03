import { expect, test, vi } from 'vitest'
import { type CommunityListingRecord } from './types.ts'

const mockModule = vi.hoisted(() => ({
	listAllCommunityListings: vi.fn(),
	getCommunityRatingAggregatesByListingIds: vi.fn(),
	countCommunityForksByListingIds: vi.fn(),
}))

vi.mock('./repo.ts', () => ({
	listAllCommunityListings: (...args: Array<unknown>) =>
		mockModule.listAllCommunityListings(...args),
	getCommunityRatingAggregatesByListingIds: (...args: Array<unknown>) =>
		mockModule.getCommunityRatingAggregatesByListingIds(...args),
	countCommunityForksByListingIds: (...args: Array<unknown>) =>
		mockModule.countCommunityForksByListingIds(...args),
}))

const {
	COMMUNITY_SEARCH_VECTOR_MATCH_THRESHOLD,
	buildCommunityListingSearchDocument,
	computeCommunityBayesianScore,
	isCommunityListingSearchMatch,
	searchCommunityListings,
} = await import('./service.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
	} as Env
}

function githubListing(): CommunityListingRecord {
	return {
		id: 'listing-github',
		ownerUserId: 'owner-kody',
		packageId: 'package-github',
		sourceId: 'source-github',
		kodyId: 'github-triage',
		name: '@kody/github-triage',
		description: 'Triage GitHub issues automatically',
		tags: ['github', 'issues', 'triage'],
		searchText: 'github issues triage',
		readmeContent: '# GitHub Triage\n\n## Intent\n\nTriage github issues.',
		license: 'MIT',
		pinnedCommit: 'commit-github',
		status: 'active',
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
		publishedAt: '2026-07-01T00:00:00.000Z',
	}
}

function mealListing(): CommunityListingRecord {
	return {
		id: 'listing-meal',
		ownerUserId: 'owner-jane',
		packageId: 'package-meal',
		sourceId: 'source-meal',
		kodyId: 'meal-planner',
		name: '@jane/meal-planner',
		description: 'Plan weekly meals and grocery lists',
		tags: ['meal', 'grocery', 'planning'],
		searchText: 'meal plan grocery shopping',
		readmeContent: '# Meal Planner\n\n## Intent\n\nPlan meals.',
		license: 'MIT',
		pinnedCommit: 'commit-meal',
		status: 'active',
		createdAt: '2026-07-02T00:00:00.000Z',
		updatedAt: '2026-07-02T00:00:00.000Z',
		publishedAt: '2026-07-02T00:00:00.000Z',
	}
}

function mockListings(listings: Array<CommunityListingRecord>) {
	mockModule.listAllCommunityListings.mockResolvedValue(listings)
	mockModule.getCommunityRatingAggregatesByListingIds.mockResolvedValue(
		Object.fromEntries(
			listings.map((listing) => [
				listing.id,
				{
					listingId: listing.id,
					ratingCount: listing.id === 'listing-github' ? 8 : 2,
					averageStars: listing.id === 'listing-github' ? 4.5 : 3.5,
					averageAdaptationEffort: 2,
				},
			]),
		),
	)
	mockModule.countCommunityForksByListingIds.mockResolvedValue(
		Object.fromEntries(listings.map((listing) => [listing.id, 1])),
	)
}

test('computeCommunityBayesianScore uses prior mean for unrated listings', () => {
	expect(
		computeCommunityBayesianScore({
			averageStars: null,
			ratingCount: 0,
		}),
	).toBe(3.25)
})

test('computeCommunityBayesianScore ranks higher-rated listings above unrated ones', () => {
	const unrated = computeCommunityBayesianScore({
		averageStars: null,
		ratingCount: 0,
	})
	const highlyRated = computeCommunityBayesianScore({
		averageStars: 5,
		ratingCount: 20,
	})
	const lightlyRated = computeCommunityBayesianScore({
		averageStars: 5,
		ratingCount: 1,
	})

	expect(highlyRated).toBeGreaterThan(unrated)
	expect(highlyRated).toBeGreaterThan(lightlyRated)
	expect(lightlyRated).toBeGreaterThan(unrated)
})

test('computeCommunityBayesianScore pulls sparse ratings toward the prior', () => {
	const sparseFiveStar = computeCommunityBayesianScore({
		averageStars: 5,
		ratingCount: 1,
	})
	expect(sparseFiveStar).toBeCloseTo((3.25 * 5 + 5) / 6, 5)
})

test('isCommunityListingSearchMatch keeps lexical hits and drops unrelated cosine noise', () => {
	const githubDocument = buildCommunityListingSearchDocument(githubListing())
	const mealDocument = buildCommunityListingSearchDocument(mealListing())

	expect(
		isCommunityListingSearchMatch({
			query: 'github',
			document: githubDocument,
		}),
	).toBe(true)
	expect(
		isCommunityListingSearchMatch({
			query: 'github',
			document: mealDocument,
		}),
	).toBe(false)
	expect(
		isCommunityListingSearchMatch({
			query: 'zzqqxxy',
			document: githubDocument,
		}),
	).toBe(false)
	expect(COMMUNITY_SEARCH_VECTOR_MATCH_THRESHOLD).toBe(0.12)
})

test('searchCommunityListings filters to matching listings only', async () => {
	mockListings([mealListing(), githubListing()])

	const githubResults = await searchCommunityListings({
		env: createEnv(),
		query: 'github',
		limit: 10,
	})
	expect(githubResults.map((listing) => listing.kodyId)).toEqual([
		'github-triage',
	])

	const mealResults = await searchCommunityListings({
		env: createEnv(),
		query: 'meal plan grocery',
		limit: 10,
	})
	expect(mealResults.map((listing) => listing.kodyId)).toEqual(['meal-planner'])

	const gibberishResults = await searchCommunityListings({
		env: createEnv(),
		query: 'zzqqxxy',
		limit: 10,
	})
	expect(gibberishResults).toEqual([])
})

test('searchCommunityListings with empty query returns all listings Bayesian-sorted', async () => {
	mockListings([mealListing(), githubListing()])

	const results = await searchCommunityListings({
		env: createEnv(),
		query: '',
		limit: 10,
	})

	expect(results.map((listing) => listing.kodyId)).toEqual([
		'github-triage',
		'meal-planner',
	])
})
