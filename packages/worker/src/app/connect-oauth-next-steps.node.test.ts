import { expect, test, vi } from 'vitest'
import { buildForkPrompt } from '#app/community-public.ts'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	buildConnectOauthCreateHelpersPrompt,
	buildConnectOauthNextSteps,
	buildConnectOauthNextStepsGuidance,
	buildConnectOauthPackageSuggestion,
	connectOauthCommunitySearchCandidateLimit,
	connectOauthPackageSuggestionLimit,
	loadConnectOauthNextSteps,
	rankTrustedFirstCommunityListings,
} from './connect-oauth-next-steps.ts'

const mockModule = vi.hoisted(() => ({
	searchCommunityListings: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	searchCommunityListings: (...args: Array<unknown>) =>
		mockModule.searchCommunityListings(...args),
}))

function listing(
	overrides: Partial<CommunityListingWithAggregates> &
		Pick<CommunityListingWithAggregates, 'id' | 'name' | 'trusted'>,
): CommunityListingWithAggregates {
	return {
		ownerUserId: 'owner',
		packageId: 'pkg',
		sourceId: 'src',
		kodyId: overrides.kodyId ?? `@owner/${overrides.name}`,
		description: overrides.description ?? `${overrides.name} helpers`,
		tags: [],
		searchText: null,
		readmeContent: null,
		license: 'MIT',
		pinnedCommit: 'abc',
		iconCommit: 'abc',
		status: 'active',
		trustedCommit: overrides.trusted ? 'abc' : null,
		trustedAt: overrides.trusted ? '2026-01-01T00:00:00.000Z' : null,
		featuredAt: null,
		featured: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		publishedAt: '2026-01-01T00:00:00.000Z',
		averageStars: null,
		ratingCount: 0,
		averageAdaptationEffort: null,
		forkCount: 0,
		starCount: 0,
		...overrides,
	}
}

test('buildConnectOauthNextSteps ranks trusted-first, caps suggestions, and varies guidance by trust', () => {
	expect(
		rankTrustedFirstCommunityListings([
			{ id: 'u1', trusted: false },
			{ id: 't1', trusted: true },
			{ id: 'u2', trusted: false },
			{ id: 't2', trusted: true },
		]).map((entry) => entry.id),
	).toEqual(['t1', 't2', 'u1', 'u2'])

	const trustedListing = listing({
		id: 'trusted-google',
		name: 'google-helpers',
		trusted: true,
		description: 'Trusted google helpers',
	})
	const nextSteps = buildConnectOauthNextSteps({
		integrationName: 'google',
		baseUrl: 'https://example.com',
		listings: [
			listing({
				id: 'untrusted-google',
				name: 'google-untrusted',
				trusted: false,
				description: 'Community google helpers',
			}),
			trustedListing,
			listing({
				id: 'other',
				name: 'google-extra',
				trusted: false,
			}),
			listing({
				id: 'fourth',
				name: 'google-fourth',
				trusted: true,
			}),
		],
	})

	expect(nextSteps.integrationName).toBe('google')
	expect(nextSteps.suggestions).toHaveLength(connectOauthPackageSuggestionLimit)
	expect(
		nextSteps.suggestions.map((suggestion) => suggestion.listingId),
	).toEqual(['trusted-google', 'fourth', 'untrusted-google'])
	expect(nextSteps.suggestions[0]).toEqual(
		buildConnectOauthPackageSuggestion({
			baseUrl: 'https://example.com',
			listing: trustedListing,
		}),
	)
	expect(nextSteps.suggestions[0]?.forkPrompt).toBe(
		buildForkPrompt({
			name: 'google-helpers',
			listingId: 'trusted-google',
		}),
	)
	expect(nextSteps.guidance).toBe(
		buildConnectOauthNextStepsGuidance({
			integrationName: 'google',
			suggestionCount: connectOauthPackageSuggestionLimit,
			trustedSuggestionCount: 2,
		}),
	)
	expect(nextSteps.createHelpersCta).toEqual({
		label: 'Create helpers package',
		prompt: buildConnectOauthCreateHelpersPrompt('google'),
	})

	const empty = buildConnectOauthNextSteps({
		integrationName: 'linear',
		baseUrl: 'https://example.com',
		listings: [],
	})
	expect(empty.suggestions).toEqual([])
	expect(empty.guidance).toBe(
		buildConnectOauthNextStepsGuidance({
			integrationName: 'linear',
			suggestionCount: 0,
			trustedSuggestionCount: 0,
		}),
	)
	expect(empty.createHelpersCta.prompt).toBe(
		buildConnectOauthCreateHelpersPrompt('linear'),
	)

	const untrustedOnly = buildConnectOauthNextSteps({
		integrationName: 'notion',
		baseUrl: 'https://example.com',
		listings: [
			listing({
				id: 'untrusted-notion',
				name: 'notion-extra',
				trusted: false,
			}),
		],
	})
	expect(untrustedOnly.suggestions).toHaveLength(1)
	expect(untrustedOnly.suggestions[0]?.trusted).toBe(false)
	expect(untrustedOnly.guidance).toBe(
		buildConnectOauthNextStepsGuidance({
			integrationName: 'notion',
			suggestionCount: 1,
			trustedSuggestionCount: 0,
		}),
	)
	expect(untrustedOnly.guidance).not.toBe(
		buildConnectOauthNextStepsGuidance({
			integrationName: 'notion',
			suggestionCount: 1,
			trustedSuggestionCount: 1,
		}),
	)
})

test('loadConnectOauthNextSteps searches with bounded limit and fails open', async () => {
	mockModule.searchCommunityListings.mockResolvedValueOnce([
		listing({
			id: 'trusted',
			name: 'github-helpers',
			trusted: true,
		}),
		listing({
			id: 'untrusted',
			name: 'github-extra',
			trusted: false,
		}),
	])

	const env = { APP_DB: {} } as Env
	const nextSteps = await loadConnectOauthNextSteps({
		env,
		integrationName: 'github',
		providerQuery: 'GitHub',
		baseUrl: 'https://example.com',
	})

	expect(mockModule.searchCommunityListings).toHaveBeenCalledWith({
		env,
		query: 'GitHub',
		limit: connectOauthCommunitySearchCandidateLimit,
	})
	expect(nextSteps.suggestions.map((entry) => entry.listingId)).toEqual([
		'trusted',
		'untrusted',
	])

	consoleError.mockImplementation(() => {})
	mockModule.searchCommunityListings.mockRejectedValueOnce(new Error('db down'))
	const failedOpen = await loadConnectOauthNextSteps({
		env,
		integrationName: 'github',
		baseUrl: 'https://example.com',
	})
	expect(failedOpen.suggestions).toEqual([])
	expect(failedOpen.guidance).toBe(
		buildConnectOauthNextStepsGuidance({
			integrationName: 'github',
			suggestionCount: 0,
			trustedSuggestionCount: 0,
		}),
	)
	expect(failedOpen.createHelpersCta.prompt).toBe(
		buildConnectOauthCreateHelpersPrompt('github'),
	)
	expect(consoleError).toHaveBeenCalledWith(
		'Failed to load post-OAuth community package suggestions.',
		expect.objectContaining({
			integrationName: 'github',
			query: 'github',
		}),
	)
})
