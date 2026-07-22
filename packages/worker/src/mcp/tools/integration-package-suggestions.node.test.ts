import { expect, test, vi } from 'vitest'
import {
	collectIntegrationPackageSuggestions,
	maxIntegrationPackageSuggestions,
	packageIdentityMentionsProvider,
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
		providerName: 'github',
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
		providerName: 'GitHub',
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
		providerName: 'github',
		packageRows: [],
	})
	expect(failedCommunity).toEqual([])
})
