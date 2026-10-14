import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { listActiveCommunityListingsBehindPublished } from '#worker/community/repo.ts'
import { syncActiveCommunityListingToPublishedCommit } from '#worker/community/sync-active-community-listing.ts'

/**
 * Cron lane that advances active community listings still pinned behind their
 * package `published_commit`. Auto-follow on promote covers new publishes; this
 * clears listings that drifted before that landed. Per-row failures stay behind
 * and are retried on a later tick.
 */
export const communityListingBehindBackfillBatchSize = 16

export async function backfillCommunityListingsBehindPublished(input: {
	env: Env
	batchSize?: number
}): Promise<{ scanned: number; synced: number; failed: number }> {
	const batchSize = input.batchSize ?? communityListingBehindBackfillBatchSize
	let rows: Awaited<
		ReturnType<typeof listActiveCommunityListingsBehindPublished>
	>
	try {
		rows = await listActiveCommunityListingsBehindPublished(input.env.APP_DB, {
			limit: batchSize,
		})
	} catch (error) {
		// Keep the lane soft-failing so one schema/query blip does not fail the
		// whole scheduled batch; the next tick retries.
		console.warn(
			'community-listing-behind-backfill-scan-failed',
			error instanceof Error ? error.message : error,
		)
		return { scanned: 0, synced: 0, failed: 0 }
	}
	const baseUrl = getAppBaseUrl({ env: input.env })
	let synced = 0
	let failed = 0
	for (const row of rows) {
		try {
			const result = await syncActiveCommunityListingToPublishedCommit({
				env: input.env,
				baseUrl,
				ownerUserId: row.listing.ownerUserId,
				packageId: row.listing.packageId,
				publishedCommit: row.publishedCommit,
			})
			if (result === 'synced') synced += 1
		} catch (error) {
			failed += 1
			console.warn(
				'community-listing-behind-backfill-row-failed',
				row.listing.id,
				error instanceof Error ? error.message : error,
			)
		}
	}
	return { scanned: rows.length, synced, failed }
}
