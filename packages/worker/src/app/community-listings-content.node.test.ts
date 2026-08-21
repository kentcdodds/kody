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

test('community listings render sort controls, published dates, and empty states', async () => {
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
	expect(emptyCatalogHtml).toContain('data-testid="community-listings-sort"')

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
})
