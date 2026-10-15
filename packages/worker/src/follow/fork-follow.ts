import { getCommunityListingById } from '#worker/community/repo.ts'
import { hasAppDb, getFollowByTarget, insertFollow } from './repo.ts'

/**
 * Forking a listing follows the upstream package. Does not consume the
 * interactive follow-create rate limit (fork already has its own limits).
 * A second fork of the same listing keeps the existing follow.
 */
export async function ensureFollowForCommunityFork(input: {
	env: Env
	listingId: string
	followerOrgId: string
	creatorUserId: string
}): Promise<void> {
	if (!hasAppDb(input.env.APP_DB)) return
	try {
		const listing = await getCommunityListingById(input.env.APP_DB, {
			listingId: input.listingId,
			includeDelisted: true,
		})
		if (!listing || !listing.packageId || !listing.name) return
		const existing = await getFollowByTarget(input.env.APP_DB, {
			followerOrgId: input.followerOrgId,
			targetKind: 'package',
			targetId: listing.packageId,
		})
		if (existing) return
		const now = new Date().toISOString()
		await insertFollow(input.env.APP_DB, {
			id: crypto.randomUUID(),
			followerOrgId: input.followerOrgId,
			creatorUserId: input.creatorUserId,
			targetKind: 'package',
			targetOwnerId: listing.ownerUserId,
			targetId: listing.packageId,
			targetName: listing.name,
			createdAt: now,
		})
	} catch (error) {
		console.error('follow-fork-create-failed', input.listingId, error)
	}
}
