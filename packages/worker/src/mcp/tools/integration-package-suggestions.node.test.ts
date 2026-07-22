import { expect, test, vi } from 'vitest'
import {
	collectIntegrationPackageSuggestions,
	maxIntegrationPackageSuggestions,
	packageIdentityMentionsProvider,
	resolveIntegrationProviderName,
} from './integration-package-suggestions.ts'

const mockModule = vi.hoisted(() => ({
	searchCommunityListings: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	searchCommunityListings: (...args: Array<unknown>) =>
		mockModule.searchCommunityListings(...args),
}))

function createPackageRow(input: {
	kodyId: string
	name: string
	description?: string
	tags?: Array<string>
}) {
	return {
		record: {
			kodyId: input.kodyId,
			name: input.name,
			description: input.description ?? `${input.kodyId} package`,
			tags: input.tags ?? [],
		},
	}
}

function createIntegration(name: string) {
	return {
		name,
		tokenUrl: 'https://oauth2.googleapis.com/token',
		apiBaseUrl: 'https://www.googleapis.com/calendar/v3',
		flow: 'confidential' as const,
		clientIdValueName: `${name}-client-id`,
		clientSecretSecretName: `${name}ClientSecret`,
		accessTokenSecretName: `${name}AccessToken`,
		refreshTokenSecretName: `${name}RefreshToken`,
		requiredHosts: ['www.googleapis.com'],
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: ['https://www.googleapis.com/auth/calendar'],
		},
	}
}

function createCommunityListing(input: {
	id: string
	kodyId: string
	name: string
	trusted: boolean
	tags?: Array<string>
	description?: string
}) {
	return {
		id: input.id,
		ownerUserId: 'owner-1',
		packageId: `pkg-${input.id}`,
		sourceId: `source-${input.id}`,
		kodyId: input.kodyId,
		name: input.name,
		description: input.description ?? `${input.kodyId} listing`,
		tags: input.tags ?? [input.kodyId],
		searchText: null,
		readmeContent: null,
		license: 'MIT',
		pinnedCommit: 'abc123',
		iconCommit: 'abc123',
		status: 'active' as const,
		trustedCommit: input.trusted ? 'abc123' : null,
		trustedAt: input.trusted ? '2026-01-01T00:00:00.000Z' : null,
		trusted: input.trusted,
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
	}
}

test('integration package suggestions stay same-provider, user-first, and capped', async () => {
	expect(
		packageIdentityMentionsProvider(
			{ kodyId: 'github', name: '@kody/github', tags: ['github', 'api'] },
			'github',
		),
	).toBe(true)
	expect(
		packageIdentityMentionsProvider(
			{
				kodyId: 'cursor',
				name: '@kody/cursor',
				tags: ['cursor', 'api'],
			},
			'github',
		),
	).toBe(false)
	expect(
		packageIdentityMentionsProvider(
			{
				kodyId: 'google-calendar',
				name: '@user/google-calendar',
				tags: ['google', 'calendar'],
			},
			'google-calendar',
		),
	).toBe(true)

	const userRows = [
		createPackageRow({
			kodyId: 'notes',
			name: '@user/notes',
			tags: ['notes'],
		}),
		createPackageRow({
			kodyId: 'github',
			name: '@user/github',
			tags: ['github'],
		}),
		createPackageRow({
			kodyId: 'github-pr',
			name: '@user/github-pr',
			tags: ['github', 'pr'],
		}),
		createPackageRow({
			kodyId: 'github-actions',
			name: '@user/github-actions',
			tags: ['github'],
		}),
		createPackageRow({
			kodyId: 'github-issues',
			name: '@user/github-issues',
			tags: ['github'],
		}),
	]

	const withUserPackages = await collectIntegrationPackageSuggestions({
		env: {} as Env,
		baseUrl: 'https://example.com',
		integration: {
			...createIntegration('github'),
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			requiredHosts: ['api.github.com'],
			authorization: {
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				scopes: ['repo'],
			},
		},
		packageRows: userRows,
	})
	expect(mockModule.searchCommunityListings).not.toHaveBeenCalled()
	expect(withUserPackages).toHaveLength(maxIntegrationPackageSuggestions)
	expect(withUserPackages.every((item) => item.source === 'user')).toBe(true)
	expect(withUserPackages.map((item) => item.kodyId)).toEqual([
		'github',
		'github-pr',
		'github-actions',
	])

	mockModule.searchCommunityListings.mockResolvedValueOnce([
		createCommunityListing({
			id: 'listing-cursor',
			kodyId: 'cursor',
			name: '@kody/cursor',
			trusted: true,
			tags: ['cursor'],
		}),
		createCommunityListing({
			id: 'listing-github-untrusted',
			kodyId: 'github-helpers',
			name: '@someone/github-helpers',
			trusted: false,
			tags: ['github'],
		}),
		createCommunityListing({
			id: 'listing-github-trusted',
			kodyId: 'github',
			name: '@kody/github',
			trusted: true,
			tags: ['github'],
		}),
		createCommunityListing({
			id: 'listing-github-pr',
			kodyId: 'github-pr',
			name: '@kody/github-pr',
			trusted: true,
			tags: ['github', 'pr'],
		}),
		createCommunityListing({
			id: 'listing-github-extra',
			kodyId: 'github-extra',
			name: '@kody/github-extra',
			trusted: true,
			tags: ['github'],
		}),
	])

	const communityOnly = await collectIntegrationPackageSuggestions({
		env: {} as Env,
		baseUrl: 'https://example.com',
		integration: {
			...createIntegration('GitHub'),
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			requiredHosts: ['api.github.com'],
			authorization: {
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				scopes: ['repo'],
			},
		},
		packageRows: [
			createPackageRow({
				kodyId: 'notes',
				name: '@user/notes',
				tags: ['notes'],
			}),
		],
	})
	expect(mockModule.searchCommunityListings).toHaveBeenCalledTimes(1)
	expect(mockModule.searchCommunityListings).toHaveBeenCalledWith({
		env: {},
		query: 'github',
		limit: 12,
		trustedFirst: true,
	})
	expect(communityOnly).toEqual([
		expect.objectContaining({
			source: 'community',
			kodyId: 'github',
			listingId: 'listing-github-trusted',
			trusted: true,
			publicUrl: 'https://example.com/community/listing-github-trusted',
		}),
		expect.objectContaining({
			source: 'community',
			kodyId: 'github-pr',
			trusted: true,
		}),
		expect.objectContaining({
			source: 'community',
			kodyId: 'github-extra',
			trusted: true,
		}),
	])
	expect(communityOnly).toHaveLength(maxIntegrationPackageSuggestions)
	expect(
		communityOnly.every(
			(item) => item.source === 'community' && item.trusted === true,
		),
	).toBe(true)

	mockModule.searchCommunityListings.mockRejectedValueOnce(
		new Error('community unavailable'),
	)
	const failedCommunity = await collectIntegrationPackageSuggestions({
		env: {} as Env,
		baseUrl: 'https://example.com',
		integration: {
			...createIntegration('github'),
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			requiredHosts: ['api.github.com'],
			authorization: {
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				scopes: ['repo'],
			},
		},
		packageRows: [],
	})
	expect(failedCommunity).toEqual([])
})

test('account-specific integration names still match the stable provider', async () => {
	for (const integrationName of [
		'google-business',
		'google-youtube-brand',
		'google-team-2',
	]) {
		const providerName = resolveIntegrationProviderName(
			createIntegration(integrationName),
		)
		expect(providerName).toBe('google')
		expect(
			packageIdentityMentionsProvider(
				{
					kodyId: 'google-calendar',
					name: '@kody/google-calendar',
					tags: ['google', 'calendar'],
				},
				providerName,
			),
		).toBe(true)
	}

	const googleProvider = resolveIntegrationProviderName(
		createIntegration('google-business'),
	)
	expect(
		packageIdentityMentionsProvider(
			{
				kodyId: 'github',
				name: '@kody/github',
				tags: ['github'],
			},
			googleProvider,
		),
	).toBe(false)

	const acmeProvider = resolveIntegrationProviderName({
		...createIntegration('acme-business'),
		tokenUrl: 'https://auth.acme.com/oauth/token',
		apiBaseUrl: 'https://api.acme.com/v1',
		requiredHosts: ['api.acme.com'],
		authorization: {
			authorizeUrl: 'https://auth.acme.com/oauth/authorize',
			scopes: ['read'],
		},
	})
	expect(acmeProvider).toBe('acme')
	expect(
		packageIdentityMentionsProvider(
			{
				kodyId: 'google-calendar',
				name: '@kody/google-calendar',
				tags: ['google', 'calendar'],
			},
			acmeProvider,
		),
	).toBe(false)
})
