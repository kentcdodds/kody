import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { listingNeedsRepublish } from '#worker/community/listing-needs-republish.ts'
import { getCommunityListingByOwnerAndPackage } from '#worker/community/repo.ts'
import { publishCommunityListing } from '#worker/community/service.ts'

/**
 * When a package already has an active community listing, advance that listing
 * pin (and catalog snapshot) to the current `published_commit`. First-time
 * listing creation still requires an explicit visibility / communityPublish
 * step — this only keeps an existing public listing in sync with promote.
 *
 * Best-effort: callers must not unwind a successful runtime publish when this
 * rejects.
 */
export async function syncActiveCommunityListingToPublishedCommit(input: {
	env: Env
	baseUrl: string
	ownerUserId: OwnerId | string
	packageId: string
	publishedCommit: string
	actorUserId?: string
}): Promise<'synced' | 'skipped'> {
	const listing = await getCommunityListingByOwnerAndPackage(input.env.APP_DB, {
		ownerUserId: input.ownerUserId,
		packageId: input.packageId,
	})
	if (!listing || listing.status !== 'active') return 'skipped'
	if (
		!listingNeedsRepublish({
			listingPinnedCommit: listing.pinnedCommit,
			sourcePublishedCommit: input.publishedCommit,
		})
	) {
		return 'skipped'
	}
	await publishCommunityListing({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.ownerUserId as OwnerId,
		actorUserId: input.actorUserId,
		packageId: input.packageId,
	})
	return 'synced'
}
