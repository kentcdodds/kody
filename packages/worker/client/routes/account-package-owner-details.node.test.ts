import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { AccountPackageOwnerDetails } from './account-package-owner-details.tsx'
import { type AccountPackageDetail } from '#universal/loader-data.ts'

function packageDetail(
	overrides: Partial<AccountPackageDetail> = {},
): AccountPackageDetail {
	return {
		id: 'pkg-1',
		name: '@kentcdodds/demo-app',
		kodyId: 'demo-app',
		description: '',
		tags: [],
		hasApp: true,
		sourceId: 'source-1',
		lockedAt: null,
		createdAt: '2026-09-12T00:00:00.000Z',
		updatedAt: '2026-09-12T00:00:00.000Z',
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		hasCommunityListing: false,
		listingNeedsRepublish: false,
		listingAhead: null,
		forkAhead: null,
		searchText: null,
		exports: null,
		publishedCommit: null,
		pendingCommit: null,
		pendingCommitKnown: true,
		publishedVersion: null,
		unpublishedChangeCount: null,
		ownerIsPersonal: true,
		communityFork: null,
		...overrides,
	}
}

test('owner details link Open Package App when the package declares an app', async () => {
	const html = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({ hasApp: true }),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: true,
			onToggleLock: () => {},
			onPackagesPayload: () => {},
		}),
	)

	expect(html).toContain('data-testid="open-package-app"')
	expect(html).toContain('href="/@kentcdodds/packages/demo-app"')
	expect(html).toContain('Open Package App')
	expect(html).toContain('data-rmx-document')
	expect(html).toContain('data-icon="share"')
})

test('owner details show No app when the package has no app', async () => {
	const html = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({ hasApp: false }),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: true,
			onToggleLock: () => {},
			onPackagesPayload: () => {},
		}),
	)

	expect(html).toContain('No app')
	expect(html).not.toContain('data-testid="open-package-app"')
	expect(html).not.toContain('Open Package App')
})

test('owner details group visibility controls and use credentials wording', async () => {
	const html = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({
				isPrivate: true,
				isInternetVisible: false,
				hasApp: true,
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
			onPackagesPayload: () => {},
		}),
	)

	expect(html).toContain('data-testid="package-visibility-controls"')
	expect(html).toContain('data-testid="package-internet-visible-controls"')
	expect(html).toContain('data-testid="package-make-public"')
	expect(html).not.toContain('data-testid="package-update-public-listing"')
	expect(html).toContain('Make public on the community')
	expect(html).toContain('Visibility')
	expect(html).toContain('data-testid="package-internet-visible-on"')
	expect(html).toContain('Make internet-visible')
	expect(html).toContain('Review credentials')
	expect(html).toContain('data-testid="package-approve-capabilities-link"')
	expect(html).toContain('/@kentcdodds/demo-app/approve-capabilities')
})

test('owner details publishing panel shows live version, newer changes, and primary CTA', async () => {
	const upToDate = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({
				lockedAt: '2026-09-12T00:00:00.000Z',
				publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				pendingCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				publishedVersion: '1.5.0',
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
			onPackagesPayload: () => {},
		}),
	)

	expect(upToDate).toContain('data-testid="package-publishing-panel"')
	expect(upToDate).toContain('data-testid="package-publishing-live"')
	expect(upToDate).toContain('Live: 1.5.0')
	expect(upToDate).toContain('Anyone can see it on the community')
	expect(upToDate).toContain('data-testid="package-publishing-empty"')
	expect(upToDate).toContain('data-testid="account-approve-publish"')
	expect(upToDate).toContain('Review publish status')
	expect(upToDate).not.toContain('data-testid="package-publishing-newer"')

	const pending = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({
				lockedAt: '2026-09-12T00:00:00.000Z',
				publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				pendingCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				publishedVersion: '1.5.0',
				unpublishedChangeCount: 2,
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
			onPackagesPayload: () => {},
		}),
	)

	expect(pending).toContain('data-testid="package-publishing-newer"')
	expect(pending).toContain('2 changes since 1.5.0')
	expect(pending).toContain('Promote this commit')

	const personalPrivate = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({
				isPrivate: true,
				ownerIsPersonal: true,
				publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				pendingCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				publishedVersion: '1.0.0',
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
			onPackagesPayload: () => {},
		}),
	)
	expect(personalPrivate).toContain('Only you can see it')

	const orgPrivate = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'acme',
			packageDetail: packageDetail({
				isPrivate: true,
				ownerIsPersonal: false,
				publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				pendingCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
			onPackagesPayload: () => {},
		}),
	)
	expect(orgPrivate).toContain('People in your organization can see it')
})

test('owner details do not offer Update public listing when the catalog pin lags', async () => {
	const html = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'danj',
			packageDetail: packageDetail({
				isPrivate: false,
				hasCommunityListing: true,
				listingNeedsRepublish: true,
				publishedCommit: '4665dddb7b7347291bd99049ba0f67ca101ee082',
				publishedVersion: '1.5.0',
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
			onPackagesPayload: () => {},
		}),
	)

	expect(html).not.toContain('data-testid="package-update-public-listing"')
	expect(html).not.toContain('Update public listing')
	expect(html).toContain('data-testid="package-publishing-listing-syncing"')
	expect(html).toContain(
		'The community listing is catching up to this published version.',
	)
})
