import { expect, test } from 'vitest'
import { renderCommunityListingsContentHtml } from '#app/community-listings-content.tsx'

test('community empty state distinguishes a search miss from an empty catalog', async () => {
	const searchMissHtml = await renderCommunityListingsContentHtml({
		listings: [],
		query: 'obsidian',
	})

	expect(searchMissHtml).toContain('Nothing matched that search.')
	expect(searchMissHtml).toContain('Ask your agent to create this package')
	expect(searchMissHtml).toContain('data-testid="community-create-prompt"')
	expect(searchMissHtml).toContain('obsidian')
	expect(searchMissHtml).toContain(
		'coding_guide_get({ guide: "package_authoring" })',
	)
	expect(searchMissHtml).toContain(
		'coding_guide_get({ guide: "package_lifecycle" })',
	)
	expect(searchMissHtml).toContain(
		'package_get_git_remote({ kody_id, create: true })',
	)
	expect(searchMissHtml).toContain('href="/guides/package-authoring"')
	expect(searchMissHtml).toContain('href="/community"')

	const emptyCatalogHtml = await renderCommunityListingsContentHtml({
		listings: [],
		query: null,
	})

	expect(emptyCatalogHtml).toContain('The shelf is <em>waiting</em>.')
	expect(emptyCatalogHtml).toContain('Connect your agent')
	expect(emptyCatalogHtml).not.toContain(
		'Ask your agent to create this package',
	)
	expect(emptyCatalogHtml).not.toContain(
		'data-testid="community-create-prompt"',
	)
})
