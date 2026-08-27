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

const detailBase = {
	ownerProfilePublic: true,
	viewerFollowsOwner: false,
	viewerIsOwner: false,
	returnTo: '/@kentcdodds/github-triage',
	followError: null,
} as const

test('community detail head covers install, installed, and listing-ahead badges', async () => {
	const installHtml = await renderCommunityDetailContentHtml({
		listing: sampleListing,
		...detailBase,
		loggedIn: true,
		starredByViewer: false,
	})
	expect(installHtml).toContain('data-testid="community-detail-install"')
	expect(installHtml).toContain('data-community-install')
	expect(installHtml).toContain('data-trusted="false"')

	const agentPrompt =
		'Call package_get for @me/github-triage and adapt it to my needs.'
	const installedHtml = await renderCommunityDetailContentHtml({
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
		...detailBase,
		loggedIn: true,
		starredByViewer: false,
	})
	expect(installedHtml).toContain(
		'data-testid="community-detail-trusted-badge"',
	)
	expect(installedHtml).toContain(
		'data-testid="community-detail-viewer-install-badge"',
	)
	expect(installedHtml).toContain('Installed')
	expect(installedHtml).not.toContain('data-copy-prompt')
	expect(installedHtml).not.toContain(agentPrompt)
	expect(installedHtml).not.toContain('data-testid="community-detail-install"')

	const ownInstalledHtml = await renderCommunityDetailContentHtml({
		listing: {
			...sampleListing,
			viewerInstall: {
				status: 'installed',
				targetName: '@kentcdodds/github-triage',
				agentPrompt,
				packageId: 'pkg-1',
				listingAhead: false,
				listingAheadPrompt: null,
			},
		},
		...detailBase,
		viewerIsOwner: true,
		loggedIn: true,
		starredByViewer: false,
	})
	expect(ownInstalledHtml).not.toContain(
		'data-testid="community-detail-viewer-install-badge"',
	)
	expect(ownInstalledHtml).not.toContain(
		'data-testid="community-detail-install"',
	)
	expect(ownInstalledHtml).not.toContain('data-copy-prompt')

	const aheadPrompt =
		'Compare the current listing snapshot, keep local customizations, then call community_fork_absorb.'
	const aheadHtml = await renderCommunityDetailContentHtml({
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
		...detailBase,
		returnTo: '/community',
		loggedIn: true,
		starredByViewer: false,
	})
	expect(aheadHtml).toContain(
		'data-testid="community-detail-listing-ahead-badge"',
	)
	expect(aheadHtml).toContain('data-fork-outdated-copy')
	expect(aheadHtml).toContain(aheadPrompt)
	expect(aheadHtml).not.toContain(
		'data-testid="community-detail-viewer-install-badge"',
	)
	expect(aheadHtml).not.toContain('data-testid="community-detail-install"')
})

test('community detail title star covers empty, starred, and logged-out states', async () => {
	const emptyHtml = await renderCommunityDetailContentHtml({
		listing: sampleListing,
		...detailBase,
		loggedIn: true,
		starredByViewer: false,
	})
	expect(emptyHtml).toContain('data-testid="community-detail-star"')
	expect(emptyHtml).toContain('data-community-star')
	expect(emptyHtml).toContain('data-starred="false"')
	expect(emptyHtml).toContain('data-listing-name=')
	expect(emptyHtml).toContain('data-community-star-label')
	expect(emptyHtml).toContain('data-community-star-count')
	expect(emptyHtml).toContain('data-community-follow')
	expect(emptyHtml).toContain('data-follow-username="kentcdodds"')
	expect(
		emptyHtml.indexOf('data-testid="community-detail-star"'),
	).toBeGreaterThan(emptyHtml.indexOf('<h1'))

	const starredHtml = await renderCommunityDetailContentHtml({
		listing: sampleListing,
		...detailBase,
		loggedIn: true,
		starredByViewer: true,
	})
	expect(starredHtml).toContain('data-starred="true"')

	const loggedOutHtml = await renderCommunityDetailContentHtml({
		listing: sampleListing,
		...detailBase,
		loggedIn: false,
		starredByViewer: false,
	})
	expect(loggedOutHtml).toContain('data-testid="community-detail-star"')
	expect(loggedOutHtml).toContain(
		'/login?redirectTo=%2F%40kentcdodds%2Fgithub-triage',
	)
	expect(loggedOutHtml).not.toMatch(
		/data-testid="community-detail-star"[^>]*data-starred=/,
	)
})
