import { expect, test, vi } from 'vitest'
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

test('rankTrustedFirstCommunityListings keeps relevance order within trust groups', () => {
	const ranked = rankTrustedFirstCommunityListings([
		{ id: 'u1', trusted: false },
		{ id: 't1', trusted: true },
		{ id: 'u2', trusted: false },
		{ id: 't2', trusted: true },
	])
	expect(ranked.map((entry) => entry.id)).toEqual(['t1', 't2', 'u1', 'u2'])
})

test('buildConnectOauthNextSteps returns trusted-first suggestions and create CTA', () => {
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
			listing({
				id: 'trusted-google',
				name: 'google-helpers',
				trusted: true,
				description: 'Trusted google helpers',
			}),
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
	expect(nextSteps.suggestions[0]).toMatchObject({
		listingId: 'trusted-google',
		name: 'google-helpers',
		kodyId: '@owner/google-helpers',
		description: 'Trusted google helpers',
		trusted: true,
		publicUrl: 'https://example.com/community/trusted-google',
	})
	expect(nextSteps.suggestions[0]?.forkPrompt).toContain('community_get')
	expect(nextSteps.suggestions[0]?.forkPrompt).toContain('trusted-google')
	expect(nextSteps.guidance).toContain('auth credentials only')
	expect(nextSteps.guidance).toContain('not an agent-callable package')
	expect(nextSteps.guidance).toContain('Prefer a trusted community listing')
	expect(nextSteps.createHelpersCta).toEqual({
		label: 'Create helpers package',
		prompt: buildConnectOauthCreateHelpersPrompt('google'),
	})
	expect(nextSteps.createHelpersCta.prompt).toContain('thin helpers package')
	expect(nextSteps.createHelpersCta.prompt).toContain('google')
})

test('buildConnectOauthNextSteps empty listings still guides create path', () => {
	const nextSteps = buildConnectOauthNextSteps({
		integrationName: 'linear',
		baseUrl: 'https://example.com',
		listings: [],
	})
	expect(nextSteps.suggestions).toEqual([])
	expect(nextSteps.guidance).toBe(
		buildConnectOauthNextStepsGuidance({
			integrationName: 'linear',
			suggestionCount: 0,
			trustedSuggestionCount: 0,
		}),
	)
	expect(nextSteps.guidance).toContain('No close community helpers package')
	expect(nextSteps.createHelpersCta.prompt).toContain('linear')
})

test('buildConnectOauthNextSteps avoids trusted copy when only untrusted listings match', () => {
	const nextSteps = buildConnectOauthNextSteps({
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
	expect(nextSteps.suggestions).toHaveLength(1)
	expect(nextSteps.suggestions[0]?.trusted).toBe(false)
	expect(nextSteps.guidance).toContain('none are trusted yet')
	expect(nextSteps.guidance).not.toContain('Prefer a trusted community listing')
})

test('buildConnectOauthPackageSuggestion includes fork CTA fields', () => {
	const suggestion = buildConnectOauthPackageSuggestion({
		baseUrl: 'https://heykody.dev',
		listing: listing({
			id: 'listing-1',
			name: 'spotify-helpers',
			kodyId: '@kent/spotify-helpers',
			description: 'Spotify playback helpers',
			trusted: true,
		}),
	})
	expect(suggestion).toEqual({
		listingId: 'listing-1',
		name: 'spotify-helpers',
		kodyId: '@kent/spotify-helpers',
		description: 'Spotify playback helpers',
		trusted: true,
		publicUrl: 'https://heykody.dev/community/listing-1',
		forkPrompt: expect.stringContaining('spotify-helpers'),
	})
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
	expect(failedOpen.guidance).toContain('No close community helpers package')
	expect(failedOpen.createHelpersCta.prompt).toContain('github')
	expect(consoleError).toHaveBeenCalledWith(
		'Failed to load post-OAuth community package suggestions.',
		expect.objectContaining({
			integrationName: 'github',
			query: 'github',
		}),
	)
})
