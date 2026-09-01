import { expect, test, vi } from 'vitest'
import type * as CommunityRepo from './repo.ts'
import { type CommunityListingRecord } from './types.ts'

const mockModule = vi.hoisted(() => ({
	listCommunityListingCandidates: vi.fn(),
	getCommunityRatingAggregatesByListingIds: vi.fn(),
	countCommunityForksByListingIds: vi.fn(),
}))

vi.mock('./repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof CommunityRepo>()
	return {
		// Pure helper used by the service to decide whether the SQL LIKE
		// pre-filter was applied; keep the real implementation.
		extractCommunityListingLikeTokens: actual.extractCommunityListingLikeTokens,
		listCommunityListingCandidates: (...args: Array<unknown>) =>
			mockModule.listCommunityListingCandidates(...args),
		getCommunityRatingAggregatesByListingIds: (...args: Array<unknown>) =>
			mockModule.getCommunityRatingAggregatesByListingIds(...args),
		countCommunityForksByListingIds: (...args: Array<unknown>) =>
			mockModule.countCommunityForksByListingIds(...args),
	}
})

const {
	COMMUNITY_SEARCH_CANDIDATE_LIMIT,
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
		category: 'integrations',
		searchText: 'github issues triage',
		readmeContent: '# GitHub Triage\n\n## Intent\n\nTriage github issues.',
		license: 'MIT',
		pinnedCommit: 'commit-github',
		iconCommit: 'commit-github',
		status: 'active',
		trustedCommit: null,
		trustedAt: null,
		trusted: false,
		featuredAt: null,
		featured: false,
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
		category: 'productivity',
		searchText: 'meal plan grocery shopping',
		readmeContent: '# Meal Planner\n\n## Intent\n\nPlan meals.',
		license: 'MIT',
		pinnedCommit: 'commit-meal',
		iconCommit: 'commit-meal',
		status: 'active',
		trustedCommit: null,
		trustedAt: null,
		trusted: false,
		featuredAt: null,
		featured: false,
		createdAt: '2026-07-02T00:00:00.000Z',
		updatedAt: '2026-07-02T00:00:00.000Z',
		publishedAt: '2026-07-02T00:00:00.000Z',
	}
}

function mockListings(listings: Array<CommunityListingRecord>) {
	mockModule.listCommunityListingCandidates.mockResolvedValue(listings)
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

test('community scoring and search rank listings and filter by query', async () => {
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

	expect(unrated).toBe(3.25)
	expect(highlyRated).toBeGreaterThan(unrated)
	expect(highlyRated).toBeGreaterThan(lightlyRated)
	expect(lightlyRated).toBeGreaterThan(unrated)
	expect(lightlyRated).toBeCloseTo((3.25 * 5 + 5) / 6, 5)

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

	mockListings([mealListing(), githubListing()])

	const githubResults = await searchCommunityListings({
		env: createEnv(),
		query: 'github',
		limit: 10,
	})
	expect(githubResults.map((listing) => listing.kodyId)).toEqual([
		'github-triage',
	])
	expect(githubResults[0]?.relevance).toBeGreaterThanOrEqual(0.2)
	expect(mockModule.listCommunityListingCandidates).toHaveBeenCalledWith(
		expect.anything(),
		{
			includeDelisted: false,
			limit: COMMUNITY_SEARCH_CANDIDATE_LIMIT,
			query: 'github',
			category: null,
		},
	)

	const mealResults = await searchCommunityListings({
		env: createEnv(),
		query: 'meal plan grocery',
		limit: 10,
	})
	expect(mealResults.map((listing) => listing.kodyId)).toEqual(['meal-planner'])
	expect(mealResults[0]?.relevance).toBeGreaterThanOrEqual(0.2)

	const gibberishResults = await searchCommunityListings({
		env: createEnv(),
		query: 'zzqqxxy',
		limit: 10,
	})
	expect(gibberishResults).toEqual([])

	const unrelatedResults = await searchCommunityListings({
		env: createEnv(),
		query: 'text to speech audio narration',
		limit: 10,
	})
	expect(unrelatedResults).toEqual([])

	const allResults = await searchCommunityListings({
		env: createEnv(),
		query: '',
		limit: 10,
	})
	expect(allResults.map((listing) => listing.kodyId)).toEqual([
		'github-triage',
		'meal-planner',
	])
	expect(allResults.every((listing) => listing.relevance === null)).toBe(true)

	const newestBrowse = await searchCommunityListings({
		env: createEnv(),
		query: '',
		limit: 10,
		sort: 'newest',
	})
	expect(newestBrowse.map((listing) => listing.kodyId)).toEqual([
		'meal-planner',
		'github-triage',
	])

	const olderGithub = githubListing()
	const newerGithub = {
		...githubListing(),
		id: 'listing-github-newer',
		kodyId: 'github-newer',
		name: '@kody/github-newer',
		publishedAt: '2026-07-20T00:00:00.000Z',
	}
	mockListings([olderGithub, newerGithub])
	mockModule.getCommunityRatingAggregatesByListingIds.mockResolvedValue({
		'listing-github': {
			listingId: 'listing-github',
			ratingCount: 20,
			averageStars: 5,
			averageAdaptationEffort: 2,
		},
		'listing-github-newer': {
			listingId: 'listing-github-newer',
			ratingCount: 0,
			averageStars: null,
			averageAdaptationEffort: null,
		},
	})

	const bestGithub = await searchCommunityListings({
		env: createEnv(),
		query: 'github',
		limit: 10,
		sort: 'best',
	})
	expect(bestGithub.map((listing) => listing.id)).toEqual([
		'listing-github',
		'listing-github-newer',
	])

	const newestGithub = await searchCommunityListings({
		env: createEnv(),
		query: 'github',
		limit: 10,
		sort: 'newest',
	})
	expect(newestGithub.map((listing) => listing.id)).toEqual([
		'listing-github-newer',
		'listing-github',
	])

	const integrationsOnly = await searchCommunityListings({
		env: createEnv(),
		query: '',
		limit: 10,
		category: 'integrations',
	})
	expect(integrationsOnly.map((listing) => listing.kodyId)).toEqual([
		'github-triage',
		'github-newer',
	])
	const productivityOnly = await searchCommunityListings({
		env: createEnv(),
		query: '',
		limit: 10,
		category: 'productivity',
	})
	expect(productivityOnly).toEqual([])
})

test('community search resultFilter applies before limiting', async () => {
	const falsePositives = Array.from({ length: 12 }, (_, index) => ({
		...githubListing(),
		id: `listing-workflow-${String(index + 1).padStart(2, '0')}`,
		kodyId: `workflow-${index + 1}`,
		name: `@owner/workflow-${index + 1}`,
	}))
	const realProviderListing = {
		...githubListing(),
		id: 'real-provider-listing',
		kodyId: 'github-helpers',
		name: '@owner/github-helpers',
	}
	mockListings([...falsePositives, realProviderListing])

	const providerFiltered = await searchCommunityListings({
		env: createEnv(),
		query: 'github',
		limit: 1,
		resultFilter: (listing) => listing.id === 'real-provider-listing',
	})
	expect(providerFiltered.map((listing) => listing.id)).toEqual([
		'real-provider-listing',
	])
})
