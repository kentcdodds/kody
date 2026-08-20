import { expect, test } from 'vitest'
import { renderCommunityListingsContentHtml } from '#app/community-listings-content.tsx'

test('community empty state distinguishes a search miss from an empty catalog', async () => {
	const searchMissHtml = await renderCommunityListingsContentHtml({
		listings: [],
		query: 'obsidian',
	})

	expect(searchMissHtml).toContain('data-testid="community-create-prompt"')
	expect(searchMissHtml).toContain('obsidian')
	expect(searchMissHtml).toContain('href="/guides/package-authoring"')
	expect(searchMissHtml).toContain('href="/community"')

	const emptyCatalogHtml = await renderCommunityListingsContentHtml({
		listings: [],
		query: null,
	})

	expect(emptyCatalogHtml).not.toContain(
		'data-testid="community-create-prompt"',
	)
	expect(emptyCatalogHtml).toContain('href="/onboarding"')
})
