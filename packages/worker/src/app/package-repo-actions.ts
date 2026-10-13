import { buildPackageAppPath } from '@kody-internal/shared/public-urls.ts'
import { type PublicCommunityListing } from '#app/community-public.ts'
import { type PackagePageAccess } from '#app/package-page.ts'
import { type ViewerListingInstall } from '#universal/community-public-types.ts'
import { type PackageRepoActions } from '#universal/package-title-actions.tsx'
import { routes } from '#universal/routes.ts'
import { buildUpdatePublicListingHref } from '#universal/update-public-listing.ts'
import { buildPackagePublishApprovalPath } from '#worker/package-registry/package-publish-lock.ts'

export function buildSourceAheadPublishHref(input: {
	username: string
	kodyId: string
	headCommit: string | null | undefined
}) {
	if (input.headCommit) {
		return buildPackagePublishApprovalPath({
			username: input.username,
			kodyId: input.kodyId,
			commit: input.headCommit,
		})
	}
	return routes.communityPackageApprovePublish.href({
		username: input.username,
		kodyId: input.kodyId,
	})
}

/**
 * One action model for every package tab (Repo frame, Files payload, Settings
 * shell and API). The fork login link returns to the Repo tab, so the model
 * stays the same for every anonymous visitor and the anonymous files payload
 * remains shareable.
 */
export function buildPackageRepoActions(input: {
	username: string
	kodyId: string
	listing: PublicCommunityListing | null
	/** Page-level overlay; wins over the listing row's copy when both exist. */
	viewerInstall?: ViewerListingInstall | null
	viewerIsOwner: boolean
	viewerCanManage: boolean
	loggedIn: boolean
	ownerPackage: {
		hasApp: boolean
		listingNeedsRepublish?: boolean
	} | null
}): PackageRepoActions {
	const { listing } = input
	const repoHref = routes.communityPackage.href({
		username: input.username,
		kodyId: input.kodyId,
	})
	const fork =
		listing && !input.viewerIsOwner
			? {
					listingId: listing.id,
					trusted: listing.trusted,
					loggedIn: input.loggedIn,
					loginHref: routes.login.href(null, {
						searchParams: { redirectTo: repoHref },
					}),
					viewerInstall: input.viewerInstall ?? listing.viewerInstall ?? null,
				}
			: null
	const publishHref =
		input.viewerCanManage && listing?.sourceAhead
			? buildSourceAheadPublishHref({
					username: listing.ownerUsername,
					kodyId: listing.kodyId,
					headCommit: listing.headCommit,
				})
			: null
	// Trust only the fresh owner projection, never the cached listing pin: a
	// stale cached pin after republish would keep this visible.
	const updateListingHref =
		input.viewerCanManage &&
		listing != null &&
		input.ownerPackage?.listingNeedsRepublish === true
			? buildUpdatePublicListingHref({
					username: listing.ownerUsername,
					kodyId: listing.kodyId,
				})
			: null
	const packageAppHref =
		input.viewerIsOwner && input.ownerPackage?.hasApp === true
			? buildPackageAppPath({ username: input.username, kodyId: input.kodyId })
			: null
	return { fork, publishHref, updateListingHref, packageAppHref }
}

export function buildPackageRepoActionsForPage(
	page: Extract<PackagePageAccess, { kind: 'page' }>,
) {
	return buildPackageRepoActions({
		username: page.username,
		kodyId: page.kodyId,
		listing: page.listing?.listing ?? null,
		viewerInstall: page.listing?.viewerInstall,
		viewerIsOwner: page.viewerIsOwner,
		viewerCanManage: page.viewerCanManage,
		loggedIn: page.loggedIn,
		ownerPackage: page.ownerPackage,
	})
}
