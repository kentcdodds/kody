import { type CommunityListingRelease } from '#worker/community/fork-upstream-updated-subscription-event.ts'
import { deliverFollowRecords } from './deliver.ts'
import { hasAppDb, listActiveFollowsByTarget } from './repo.ts'

/**
 * Fan `follow.published` out to active follows of a package whose live
 * version moved. When `listing` is set, the same delivery emits the
 * `community.fork.upstream_updated` alias for forks of that listing.
 * Best-effort: a failure here must not unwind publish.
 */
export async function notifyFollowsOfPublishedPackage(input: {
	env: Env
	ownerId: string
	packageId: string
	previousCommit: string | null
	publishedCommit: string
	publishedAt: string
	listing?: {
		listingId: string
		previous: CommunityListingRelease
		current: CommunityListingRelease
	} | null
}): Promise<void> {
	if (!hasAppDb(input.env.APP_DB)) return
	if (input.previousCommit === input.publishedCommit) return
	try {
		const follows = await listActiveFollowsByTarget(input.env.APP_DB, {
			targetKind: 'package',
			targetId: input.packageId,
		})
		if (follows.length === 0) return
		await deliverFollowRecords({
			env: input.env,
			follows,
			now: new Date(input.publishedAt),
			published: {
				previousCommit: input.previousCommit,
				publishedCommit: input.publishedCommit,
				publishedAt: input.publishedAt,
				listing: input.listing ?? null,
			},
		})
	} catch (error) {
		console.error('follow-published-notify-failed', input.packageId, error)
	}
}
