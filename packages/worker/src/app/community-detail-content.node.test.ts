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
	version: '1.0.4',
	pinnedCommit: 'abc1234567890',
	publishedAt: '2026-07-13T00:00:00.000Z',
	ownerUsername: 'kentcdodds',
	trusted: false,
	featured: false,
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
} satisfies PublicCommunityListing

const detailBase = {
	listing: sampleListing,
	username: 'kentcdodds',
	kodyId: 'github-triage',
	description: sampleListing.description,
	isPrivate: false,
	ownerProfilePublic: true,
	viewerIsOwner: false,
	returnTo: '/@kentcdodds/github-triage',
} as const

test('community detail head covers install, installed, and listing-ahead badges', async () => {
	const installHtml = await renderCommunityDetailContentHtml({
		...detailBase,
		loggedIn: true,
	})
	expect(installHtml).toContain('data-testid="community-detail-install"')
	expect(installHtml).toContain('data-community-install')
	expect(installHtml).toContain('data-trusted="false"')

	const agentPrompt =
		'Call packageGet for @me/github-triage and adapt it to my needs.'
	const installedHtml = await renderCommunityDetailContentHtml({
		...detailBase,
		listing: {
			...sampleListing,
			viewerInstall: {
				status: 'installed',
				targetName: '@me/github-triage',
				agentPrompt,
				packageId: 'pkg-1',
				listingAhead: false,
				listingAheadPrompt: null,
			},
		},
		loggedIn: true,
	})
	expect(installedHtml).toContain(
		'data-testid="community-detail-viewer-install-badge"',
	)
	expect(installedHtml).not.toContain('data-copy-prompt')
	expect(installedHtml).not.toContain(agentPrompt)
	expect(installedHtml).not.toContain('data-testid="community-detail-install"')

	const sourceAheadHtml = await renderCommunityDetailContentHtml({
		...detailBase,
		listing: {
			...sampleListing,
			sourceAhead: true,
		},
		loggedIn: true,
	})
	expect(sourceAheadHtml).toContain(
		'data-testid="community-detail-source-ahead-badge"',
	)

	const ownInstalledHtml = await renderCommunityDetailContentHtml({
		...detailBase,
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
		viewerIsOwner: true,
		loggedIn: true,
	})
	expect(ownInstalledHtml).not.toContain(
		'data-testid="community-detail-viewer-install-badge"',
	)
	expect(ownInstalledHtml).not.toContain(
		'data-testid="community-detail-install"',
	)
	expect(ownInstalledHtml).not.toContain('data-copy-prompt')

	const aheadPrompt =
		'Compare the current listing snapshot, keep local customizations, then publish with repoPublishSession and absorbed_upstream_commit.'
	const aheadHtml = await renderCommunityDetailContentHtml({
		...detailBase,
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
		returnTo: '/community',
		loggedIn: true,
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

test('package chrome is shared for public listings and private owner packages', async () => {
	const publicHtml = await renderCommunityDetailContentHtml({
		...detailBase,
		loggedIn: false,
	})
	expect(publicHtml).toContain('data-testid="package-repo-chrome"')
	expect(publicHtml).toContain('data-testid="package-repo-nav-code"')
	expect(publicHtml).not.toContain('data-testid="package-repo-nav-settings"')
	expect(publicHtml).toContain('data-visibility="public"')
	expect(publicHtml).toContain('data-testid="community-browse-files"')
	expect(publicHtml).toContain('href="/@kentcdodds/github-triage/tree/main"')
	expect(publicHtml).toContain('data-testid="community-detail-forks"')
	expect(publicHtml).toContain('data-testid="community-detail-version"')
	expect(publicHtml).toContain('← Public packages')

	const noVersionHtml = await renderCommunityDetailContentHtml({
		...detailBase,
		listing: { ...sampleListing, version: null },
		loggedIn: false,
	})
	expect(noVersionHtml).not.toContain('data-testid="community-detail-version"')

	const ownerHtml = await renderCommunityDetailContentHtml({
		...detailBase,
		viewerIsOwner: true,
		loggedIn: true,
	})
	expect(ownerHtml).toContain('data-testid="package-repo-nav-settings"')
	expect(ownerHtml).toContain('href="/@kentcdodds/github-triage/settings"')
	expect(ownerHtml).toContain('← Packages')

	const privateHtml = await renderCommunityDetailContentHtml({
		...detailBase,
		listing: null,
		isPrivate: true,
		viewerIsOwner: true,
		loggedIn: true,
		description: 'Local notes.',
	})
	expect(privateHtml).toContain('data-testid="package-repo-chrome"')
	expect(privateHtml).toContain('data-visibility="private"')
	expect(privateHtml).toContain('data-testid="package-repo-nav-settings"')
	expect(privateHtml).toContain('href="/@kentcdodds/github-triage/tree/main"')
	expect(privateHtml).not.toContain('data-testid="community-detail-forks"')
	expect(privateHtml).not.toContain('data-testid="community-listing-category"')
	expect(privateHtml).toContain('Local notes.')
})
