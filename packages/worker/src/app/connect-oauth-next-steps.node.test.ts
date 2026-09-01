import { expect, test, vi } from 'vitest'
import { buildForkPrompt } from '#app/community-public.ts'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	buildConnectOauthCreateHelpersPrompt,
	buildConnectOauthNextSteps,
	buildConnectOauthNextStepsGuidance,
	buildConnectOauthPackageSuggestion,
	communityListingUsesProvider,
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
	const kodyId = overrides.kodyId ?? overrides.name.replace(/^@[^/]+\//, '')
	const name = overrides.name.startsWith('@')
		? overrides.name
		: `@owner/${kodyId}`
	return {
		ownerUserId: 'owner',
		packageId: 'pkg',
		sourceId: 'src',
		description: overrides.description ?? `${overrides.name} helpers`,
		tags: [],
		category: 'integrations',
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
		...overrides,
		kodyId,
		name,
	}
}

function githubIntegration() {
	return {
		name: 'github',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		requiredHosts: ['api.github.com'],
		authorization: {
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			scopes: ['repo'],
		},
	}
}

test('buildConnectOauthNextSteps preserves relevance order, caps suggestions, and varies guidance by count', () => {
	expect(
		rankTrustedFirstCommunityListings([
			{ id: 'u1', trusted: false },
			{ id: 't1', trusted: true },
			{ id: 'u2', trusted: false },
			{ id: 't2', trusted: true },
		]).map((entry) => entry.id),
	).toEqual(['u1', 't1', 'u2', 't2'])

	const firstListing = listing({
		id: 'untrusted-google',
		name: 'google-untrusted',
		trusted: false,
		description: 'Community google helpers',
	})
	const nextSteps = buildConnectOauthNextSteps({
		integrationName: 'google',
		baseUrl: 'https://example.com',
		listings: [
			firstListing,
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
	).toEqual(['untrusted-google', 'trusted-google', 'other'])
	expect(nextSteps.suggestions[0]).toEqual(
		buildConnectOauthPackageSuggestion({
			baseUrl: 'https://example.com',
			listing: firstListing,
		}),
	)
	expect(nextSteps.suggestions[0]?.forkPrompt).toBe(
		buildForkPrompt({
			name: '@owner/google-untrusted',
			listingId: 'untrusted-google',
		}),
	)
	expect(nextSteps.suggestions[0]?.publicUrl).toBe(
		'https://example.com/@owner/google-untrusted',
	)
	expect(nextSteps.guidance).toBe(
		buildConnectOauthNextStepsGuidance({
			integrationName: 'google',
			suggestionCount: connectOauthPackageSuggestionLimit,
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
		}),
	)
})

test('post-OAuth suggestions keep only listings that use the connected provider', () => {
	expect(
		communityListingUsesProvider(
			{
				kodyId: 'github',
				name: '@kody/github',
				tags: ['github', 'oauth'],
			},
			'github',
		),
	).toBe(true)
	expect(
		communityListingUsesProvider(
			{
				kodyId: 'cursor',
				name: '@kody/cursor',
				tags: ['cursor', 'cloud-agents'],
			},
			'github',
		),
	).toBe(false)
	expect(
		communityListingUsesProvider(
			{
				kodyId: 'morning-briefing',
				name: '@kody/morning-briefing',
				tags: ['morning', 'calendar', 'weather'],
			},
			'google',
		),
	).toBe(false)
	expect(
		communityListingUsesProvider(
			{
				kodyId: 'cal-com',
				name: '@kody/cal-com',
				tags: ['cal-com', 'calendar', 'oauth'],
			},
			'google',
		),
	).toBe(false)

	const nextSteps = buildConnectOauthNextSteps({
		integrationName: 'github',
		providerName: 'github',
		baseUrl: 'https://example.com',
		listings: [
			listing({
				id: 'trusted-cursor',
				name: 'cursor',
				trusted: true,
				description: 'Cursor API SDK for cloud agents and repositories.',
				tags: ['cursor', 'cloud-agents', 'api'],
			}),
			listing({
				id: 'raycast-pouch',
				name: 'raycast-kodys-pouch',
				trusted: false,
				description: 'Your Kody Skills and Tools, one command away.',
				tags: ['raycast', 'pouch'],
			}),
			listing({
				id: 'morning-briefing',
				name: 'morning-briefing',
				trusted: false,
				description: 'Daily briefing from calendar and weather.',
				tags: ['morning', 'calendar', 'weather'],
			}),
			listing({
				id: 'github-helpers',
				name: 'github',
				trusted: false,
				description: 'Call GitHub REST through saved GitHub OAuth.',
				tags: ['github', 'api', 'oauth'],
			}),
			listing({
				id: 'github-untrusted',
				name: 'github-extra',
				trusted: false,
				tags: ['github'],
			}),
		],
	})

	expect(nextSteps.suggestions.map((entry) => entry.listingId)).toEqual([
		'github-helpers',
		'github-untrusted',
	])
	expect(nextSteps.guidance).toBe(
		buildConnectOauthNextStepsGuidance({
			integrationName: 'github',
			suggestionCount: 2,
		}),
	)

	const googleNextSteps = buildConnectOauthNextSteps({
		integrationName: 'google-business',
		providerName: 'google',
		baseUrl: 'https://example.com',
		listings: [
			listing({
				id: 'morning-briefing',
				name: 'morning-briefing',
				trusted: true,
				description: 'Composable daily briefing from calendar and weather.',
				tags: ['morning', 'briefing', 'calendar'],
			}),
			listing({
				id: 'cal-com',
				name: 'cal-com',
				trusted: false,
				description: 'Cal.com booking pages and event types.',
				tags: ['cal-com', 'calendar', 'oauth'],
			}),
			listing({
				id: 'google-helpers',
				name: 'google',
				trusted: false,
				description: 'Call Gmail and Calendar through saved Google OAuth.',
				tags: ['google', 'gmail', 'oauth'],
			}),
		],
	})
	expect(googleNextSteps.suggestions.map((entry) => entry.listingId)).toEqual([
		'google-helpers',
	])
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
		integration: githubIntegration(),
	})

	expect(mockModule.searchCommunityListings).toHaveBeenCalledWith({
		env,
		query: 'GitHub',
		limit: connectOauthCommunitySearchCandidateLimit,
		resultFilter: expect.any(Function),
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
		integration: githubIntegration(),
	})
	expect(failedOpen.suggestions).toEqual([])
	expect(failedOpen.guidance).toBe(
		buildConnectOauthNextStepsGuidance({
			integrationName: 'github',
			suggestionCount: 0,
		}),
	)
	expect(failedOpen.createHelpersCta.prompt).toBe(
		buildConnectOauthCreateHelpersPrompt('github'),
	)
	expect(consoleError).toHaveBeenCalledWith(
		'Failed to load post-OAuth public package suggestions.',
		expect.objectContaining({
			integrationName: 'github',
			query: 'github',
		}),
	)
})

test('loadConnectOauthNextSteps resolves the stable provider and drops unrelated listings', async () => {
	const googleCandidates = [
		listing({
			id: 'morning-briefing',
			name: 'morning-briefing',
			trusted: true,
			tags: ['morning', 'calendar'],
		}),
		listing({
			id: 'cal-com',
			name: 'cal-com',
			trusted: false,
			tags: ['cal-com', 'calendar', 'oauth'],
		}),
		listing({
			id: 'google-helpers',
			name: 'google',
			trusted: false,
			tags: ['google', 'gmail', 'oauth'],
		}),
	]
	mockModule.searchCommunityListings.mockImplementationOnce(
		async (input: {
			query: string
			resultFilter?: (entry: ReturnType<typeof listing>) => boolean
		}) => {
			expect(input.query).toBe('google')
			return googleCandidates.filter((entry) =>
				input.resultFilter ? input.resultFilter(entry) : true,
			)
		},
	)

	const env = { APP_DB: {} } as Env
	const googleBusiness = await loadConnectOauthNextSteps({
		env,
		integrationName: 'google-business',
		baseUrl: 'https://example.com',
		integration: {
			name: 'google-business',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com/calendar/v3',
			requiredHosts: ['www.googleapis.com'],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: ['https://www.googleapis.com/auth/calendar'],
			},
		},
	})
	expect(googleBusiness.suggestions.map((entry) => entry.listingId)).toEqual([
		'google-helpers',
	])

	mockModule.searchCommunityListings.mockResolvedValueOnce([
		listing({
			id: 'trusted-cursor',
			name: 'cursor',
			trusted: true,
			tags: ['cursor'],
		}),
		listing({
			id: 'github-helpers',
			name: 'github',
			trusted: false,
			tags: ['github', 'oauth'],
		}),
	])
	const githubNextSteps = await loadConnectOauthNextSteps({
		env,
		integrationName: 'github',
		baseUrl: 'https://example.com',
		integration: githubIntegration(),
	})
	expect(githubNextSteps.suggestions.map((entry) => entry.listingId)).toEqual([
		'github-helpers',
	])
})
