import { expect, test } from 'vitest'
import { renderCommunityDetailContentHtml } from '#app/community-detail-content.tsx'
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

test('community detail head replaces Installed with Fork outdated when the listing is ahead', async () => {
	const aheadPrompt =
		'Compare the current listing snapshot, keep local customizations, then call community_fork_absorb.'
	const html = await renderCommunityDetailContentHtml({
		listing: {
			...sampleListing,
			viewerInstall: {
				status: 'installed',
				targetName: '@me/github-triage',
				agentPrompt: 'Finish setup for @me/github-triage.',
				packageId: 'pkg-1',
				listingAhead: true,
				listingAheadPrompt: aheadPrompt,
			},
		},
		ownerProfilePublic: true,
		loggedIn: true,
		viewerFollowsOwner: false,
		viewerIsOwner: false,
		returnTo: '/community',
		followError: null,
	})

	expect(html).toContain('data-testid="community-detail-listing-ahead-badge"')
	expect(html).toContain('data-fork-outdated-copy')
	expect(html).toContain(aheadPrompt)
	expect(html).not.toContain(
		'data-testid="community-detail-viewer-install-badge"',
	)
	expect(html).not.toContain('data-testid="community-detail-install"')
})

test('community detail head shows an Install pill when the viewer has not forked it', async () => {
	const html = await renderCommunityDetailContentHtml({
		listing: sampleListing,
		ownerProfilePublic: true,
		loggedIn: true,
		viewerFollowsOwner: false,
		viewerIsOwner: false,
		returnTo: '/@kentcdodds/github-triage',
		followError: null,
	})

	expect(html).toContain('data-testid="community-detail-install"')
	expect(html).toContain('data-community-install')
	expect(html).toContain('data-trusted="false"')
	expect(html).not.toContain('One-click install')
	expect(html).not.toContain('Fork with your agent')
})

test('community detail Installed pill copies an adapt prompt', async () => {
	const agentPrompt =
		'Call package_get for @me/github-triage and adapt it to my needs.'
	const html = await renderCommunityDetailContentHtml({
		listing: {
			...sampleListing,
			trusted: true,
			viewerInstall: {
				status: 'installed',
				targetName: '@me/github-triage',
				agentPrompt,
				packageId: 'pkg-1',
				listingAhead: false,
				listingAheadPrompt: null,
			},
		},
		ownerProfilePublic: true,
		loggedIn: true,
		viewerFollowsOwner: false,
		viewerIsOwner: false,
		returnTo: '/@kentcdodds/github-triage',
		followError: null,
	})

	expect(html).toContain('data-testid="community-detail-trusted-badge"')
	expect(html).toContain('data-testid="community-detail-viewer-install-badge"')
	expect(html).toContain('data-copy-prompt')
	expect(html).toContain(agentPrompt)
	expect(html).not.toContain('data-testid="community-detail-install"')
})
