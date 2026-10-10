import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
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
		clientId: `${name}-client-id-value`,
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
		ownerUserId: ownerIdFromStored('owner-1'),
		packageId: `pkg-${input.id}`,
		sourceId: `source-${input.id}`,
		kodyId: input.kodyId,
		name: input.name,
		description: input.description ?? `${input.kodyId} listing`,
		tags: input.tags ?? [input.kodyId],
		category: 'integrations' as const,
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
	}
}

type CommunityListingFixture = ReturnType<typeof createCommunityListing>

function githubIntegration(name = 'github') {
	return {
		...createIntegration(name),
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		requiredHosts: ['api.github.com'],
		authorization: {
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			scopes: ['repo'],
		},
	}
}

function suggest(
	integration: Parameters<
		typeof collectIntegrationPackageSuggestions
	>[0]['integration'],
	packageRows: Array<ReturnType<typeof createPackageRow>> = [],
) {
	return collectIntegrationPackageSuggestions({
		env: {} as Env,
		baseUrl: 'https://example.com',
		integration,
		packageRows,
	})
}

const packageIdentity = (
	kodyId: string,
	tags: Array<string>,
	scope = 'kody',
) => ({
	kodyId,
	name: `@${scope}/${kodyId}`,
	tags,
})
const googleCalendar = packageIdentity('google-calendar', [
	'google',
	'calendar',
])
const githubPackage = packageIdentity('github', ['github'])

test('integration package suggestions stay same-provider, user-first, and capped', async () => {
	const identityCases: Array<
		[ReturnType<typeof packageIdentity>, string, boolean]
	> = [
		[packageIdentity('github', ['github', 'api']), 'github', true],
		[packageIdentity('cursor', ['cursor', 'api']), 'github', false],
		[
			packageIdentity('google-calendar', ['google', 'calendar'], 'user'),
			'google-calendar',
			true,
		],
	]
	expect(
		identityCases.filter(
			([identity, provider, expected]) =>
				packageIdentityMentionsProvider(identity, provider) !== expected,
		),
	).toEqual([])

	const withUserPackages = await suggest(githubIntegration(), [
		createPackageRow({ kodyId: 'notes', name: '@user/notes', tags: ['notes'] }),
		...(
			[
				['github', ['github']],
				['github-pr', ['github', 'pr']],
				['github-actions', ['github']],
				['github-issues', ['github']],
			] as const
		).map(([kodyId, tags]) =>
			createPackageRow({ kodyId, name: `@user/${kodyId}`, tags: [...tags] }),
		),
	])
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
		...(
			[
				['listing-github-trusted', 'github', ['github']],
				['listing-github-pr', 'github-pr', ['github', 'pr']],
				['listing-github-extra', 'github-extra', ['github']],
			] as const
		).map(([id, kodyId, tags]) =>
			createCommunityListing({
				id,
				kodyId,
				name: `@kody/${kodyId}`,
				trusted: true,
				tags: [...tags],
			}),
		),
	])
	const communityOnly = await suggest(githubIntegration('GitHub'), [
		createPackageRow({ kodyId: 'notes', name: '@user/notes', tags: ['notes'] }),
	])
	expect(mockModule.searchCommunityListings).toHaveBeenCalledTimes(1)
	expect(mockModule.searchCommunityListings).toHaveBeenCalledWith({
		env: {},
		query: 'github',
		limit: 12,
		resultFilter: expect.any(Function),
	})
	expect(communityOnly).toEqual([
		expect.objectContaining({
			source: 'community',
			kodyId: 'github-helpers',
			listingId: 'listing-github-untrusted',
			trusted: false,
			publicUrl: 'https://example.com/@someone/github-helpers',
		}),
		expect.objectContaining({
			source: 'community',
			kodyId: 'github',
			listingId: 'listing-github-trusted',
			trusted: true,
		}),
		expect.objectContaining({
			source: 'community',
			kodyId: 'github-pr',
			trusted: true,
		}),
	])
	expect(communityOnly).toHaveLength(maxIntegrationPackageSuggestions)

	mockModule.searchCommunityListings.mockRejectedValueOnce(
		new Error('community unavailable'),
	)
	expect(await suggest(githubIntegration())).toEqual([])
})

test('community suggestions provider-filter before limiting', async () => {
	const falsePositives = Array.from({ length: 12 }, (_, index) =>
		createCommunityListing({
			id: `false-positive-${index + 1}`,
			kodyId: `workflow-${index + 1}`,
			name: `@owner/workflow-${index + 1}`,
			description: 'A workflow whose prose mentions GitHub.',
			tags: ['workflow'],
			trusted: true,
		}),
	)
	const realProviderListing = createCommunityListing({
		id: 'github-rank-13',
		kodyId: 'github-helpers',
		name: '@owner/github-helpers',
		tags: ['github'],
		trusted: false,
	})
	const relevanceOrdered = [...falsePositives, realProviderListing]
	mockModule.searchCommunityListings.mockImplementationOnce(
		async (input: {
			limit: number
			resultFilter?: (listing: CommunityListingFixture) => boolean
		}) => {
			const providerMatches = input.resultFilter
				? relevanceOrdered.filter(input.resultFilter)
				: relevanceOrdered
			return providerMatches.slice(0, input.limit)
		},
	)

	expect(await suggest(githubIntegration())).toEqual([
		expect.objectContaining({
			listingId: 'github-rank-13',
			kodyId: 'github-helpers',
		}),
	])
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
		expect(packageIdentityMentionsProvider(googleCalendar, providerName)).toBe(
			true,
		)
	}

	const legacyGoogleIntegration = {
		...createIntegration('google-business'),
		authorization: null,
	}
	expect(resolveIntegrationProviderName(legacyGoogleIntegration)).toBe('google')
	const accountSpecificSuggestions = await suggest(legacyGoogleIntegration, [
		createPackageRow(googleCalendar),
		createPackageRow(githubPackage),
	])
	expect(
		accountSpecificSuggestions.map((suggestion) => suggestion.kodyId),
	).toEqual(['google-calendar'])
	expect(mockModule.searchCommunityListings).not.toHaveBeenCalled()
	expect(packageIdentityMentionsProvider(githubPackage, 'google')).toBe(false)

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
	expect(packageIdentityMentionsProvider(googleCalendar, acmeProvider)).toBe(
		false,
	)

	const rapidApiIntegration = {
		...createIntegration('rapidapi-team'),
		tokenUrl: 'https://rapidapi.com/oauth/token',
		apiBaseUrl: 'https://api.rapidapi.com/v1',
		requiredHosts: ['api.rapidapi.com'],
		authorization: null,
	}
	expect(resolveIntegrationProviderName(rapidApiIntegration)).toBe('rapidapi')
	expect(
		resolveIntegrationProviderName({
			...rapidApiIntegration,
			name: 'rapid-team',
		}),
	).toBe('rapid-team')

	for (const providerHost of [
		'auth.eu.my-provider.co.uk',
		'auth.apac.my-provider.com.au',
	]) {
		const hyphenatedProvider = resolveIntegrationProviderName({
			...createIntegration('my-provider-business'),
			tokenUrl: `https://${providerHost}/oauth/token`,
			apiBaseUrl: `https://${providerHost}/api`,
			requiredHosts: [providerHost],
			authorization: null,
		})
		expect(hyphenatedProvider).toBe('my-provider')
		expect(
			packageIdentityMentionsProvider(
				packageIdentity('my-provider-tools', ['my-provider'], 'owner'),
				hyphenatedProvider,
			),
		).toBe(true)
	}
})
