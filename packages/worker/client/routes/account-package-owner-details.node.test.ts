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
		listingAhead: null,
		forkAhead: null,
		searchText: null,
		exports: null,
		publishedCommit: null,
		pendingCommit: null,
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

test('owner details expose independent forkable and internet-visible controls', async () => {
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
	expect(html).toContain('Make forkable')
	expect(html).toContain(
		"Lists the source on /community so anyone can read and fork it. Doesn't host your app.",
	)
	expect(html).toContain('data-testid="package-internet-visible-on"')
	expect(html).toContain('Make internet-visible')
	expect(html).toContain(
		"Kody hosts your app at a public URL anyone can open without signing in. This is separate from Community listing. Don't use it for apps that show your private data.",
	)
	expect(html).toContain('data-testid="package-approve-capabilities-link"')
	expect(html).toContain('/@kentcdodds/demo-app/approve-capabilities')
})

test('owner details show publish state and demote Approve when up to date', async () => {
	const upToDate = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({
				lockedAt: '2026-09-12T00:00:00.000Z',
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

	expect(upToDate).toContain('data-testid="package-publish-state"')
	expect(upToDate).toContain('Published version is up to date at aaaaaaa.')
	expect(upToDate).toContain('data-testid="account-approve-publish"')
	expect(upToDate).toContain('Approve a publish')
	expect(upToDate).not.toContain('Unpublished commit pending')

	const pending = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({
				lockedAt: '2026-09-12T00:00:00.000Z',
				publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				pendingCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
			onPackagesPayload: () => {},
		}),
	)

	expect(pending).toContain('Published at aaaaaaa.')
	expect(pending).toContain('Unpublished commit pending at bbbbbbb.')
	expect(pending).toContain('data-testid="account-approve-publish"')
})
