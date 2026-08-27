import { expect, test } from 'vitest'
import { renderCommunityListingsContentHtml } from '#app/community-listings-content.tsx'
import { type PublicCommunityListing } from '#universal/community-public-types.ts'

const sampleListing = {
	id: 'listing-1',
	kodyId: 'github-triage',
	name: '@kentcdodds/github-triage',
	description: 'Triage GitHub issues.',
	iconUrl: '/community/listing-1/icon/abc1234567890',
	tags: ['github'],
	category: 'integrations',
	readmeContent: '# README',
	license: 'MIT',
	pinnedCommit: 'abc1234567890',
	publishedAt: '2026-07-13T00:00:00.000Z',
	ownerUsername: 'kentcdodds',
	trusted: false,
	featured: false,
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
	starCount: 0,
} satisfies PublicCommunityListing

test('community listings render sort controls, categories, empty states, and fork-outdated', async () => {
	const searchMissHtml = await renderCommunityListingsContentHtml({
		listings: [],
		query: 'obsidian',
		sort: 'newest',
	})

	expect(searchMissHtml).toContain('data-testid="community-create-prompt"')
	expect(searchMissHtml).toContain('obsidian')
	expect(searchMissHtml).toContain('href="/guides/package-authoring"')
	expect(searchMissHtml).toContain('href="/community?sort=newest"')
	expect(searchMissHtml).toContain('data-testid="community-listings-sort"')
	expect(searchMissHtml).toContain('aria-current="page"')

	const emptyCatalogHtml = await renderCommunityListingsContentHtml({
		listings: [],
		query: null,
	})

	expect(emptyCatalogHtml).not.toContain(
		'data-testid="community-create-prompt"',
	)
	expect(emptyCatalogHtml).toContain('href="/onboarding"')
	expect(emptyCatalogHtml).not.toContain(
		'data-testid="community-listings-categories"',
	)
	expect(emptyCatalogHtml).not.toContain(
		'data-testid="community-listings-sort"',
	)

	const listingsHtml = await renderCommunityListingsContentHtml({
		listings: [sampleListing],
		query: null,
		sort: 'newest',
	})
	expect(listingsHtml).toContain(
		'data-testid="community-listing-published-listing-1"',
	)
	expect(listingsHtml).toContain('href="/community?sort=newest"')
	expect(listingsHtml).toContain('href="/community"')
	expect(listingsHtml).toContain('data-testid="community-listings-categories"')
	expect(listingsHtml).toContain(
		'href="/community?sort=newest&amp;category=integrations"',
	)
	expect(listingsHtml).not.toContain('category=utilities')
	expect(listingsHtml).not.toContain('category=other')

	const overviewHtml = await renderCommunityListingsContentHtml({
		listings: [sampleListing],
		groups: [
			{
				category: 'integrations',
				listings: [sampleListing],
				total: 4,
			},
		],
		query: null,
		sort: 'best',
	})
	expect(overviewHtml).toContain('data-testid="community-listings-overview"')
	expect(overviewHtml).toContain('href="/community?category=integrations"')
	expect(overviewHtml).not.toContain('category=apps')

	const categoryEmptyHtml = await renderCommunityListingsContentHtml({
		listings: [],
		query: null,
		category: 'apps',
	})
	expect(categoryEmptyHtml).toContain('href="/community"')
	expect(categoryEmptyHtml).toContain(
		'data-testid="community-listings-categories"',
	)
	expect(categoryEmptyHtml).toContain('href="/community?category=apps"')
	expect(categoryEmptyHtml).not.toContain('category=utilities')

	const fullGroupHtml = await renderCommunityListingsContentHtml({
		listings: [sampleListing],
		groups: [
			{
				category: 'integrations',
				listings: [sampleListing],
				total: 1,
			},
		],
		query: null,
		sort: 'best',
	})
	expect(fullGroupHtml).toContain('data-testid="community-listings-overview"')
	expect(fullGroupHtml).not.toContain('>See all ')

	const catalogWideChipsHtml = await renderCommunityListingsContentHtml({
		listings: [sampleListing],
		query: null,
		category: 'integrations',
		categoryCounts: {
			integrations: 1200,
			examples: 40,
			productivity: 0,
			apps: 0,
			utilities: 0,
			other: 0,
		},
	})
	expect(catalogWideChipsHtml).toContain('category=integrations')
	expect(catalogWideChipsHtml).toContain('category=examples')
	expect(catalogWideChipsHtml).not.toContain('category=utilities')
	expect(catalogWideChipsHtml).not.toContain('category=other')

	const installedListing = {
		...sampleListing,
		viewerInstall: {
			status: 'installed' as const,
			targetName: '@me/github-triage',
			agentPrompt: 'Finish setup for @me/github-triage.',
			packageId: 'pkg-1',
			listingAhead: false,
			listingAheadPrompt: null,
		},
	}
	const installedHtml = await renderCommunityListingsContentHtml({
		listings: [installedListing],
		query: null,
	})
	expect(installedHtml).toContain(
		'data-testid="community-listing-viewer-install-listing-1"',
	)
	expect(installedHtml).toContain('Installed')
	expect(installedHtml).not.toContain('data-copy-prompt')
	expect(installedHtml).not.toContain(
		'data-testid="community-listing-ahead-listing-1"',
	)
	expect(installedHtml).not.toContain('data-testid="community-detail-install"')

	const aheadPrompt =
		'Compare the current listing snapshot, keep local customizations, then call community_fork_absorb.'
	const aheadHtml = await renderCommunityListingsContentHtml({
		listings: [
			{
				...installedListing,
				viewerInstall: {
					...installedListing.viewerInstall,
					listingAhead: true,
					listingAheadPrompt: aheadPrompt,
				},
			},
		],
		query: null,
	})
	expect(aheadHtml).toContain('data-testid="community-listing-ahead-listing-1"')
	expect(aheadHtml).toContain('data-fork-outdated-copy')
	expect(aheadHtml).toContain(aheadPrompt)
	expect(aheadHtml).not.toContain(
		'data-testid="community-listing-viewer-install-listing-1"',
	)
})
