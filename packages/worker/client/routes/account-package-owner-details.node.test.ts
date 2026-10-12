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
	expect(html).toContain('data-testid="package-internet-visible-on"')
	expect(html).toContain('Make internet-visible')
	expect(html).toContain('data-testid="package-approve-capabilities-link"')
	expect(html).toContain('/@kentcdodds/demo-app/approve-capabilities')
})
