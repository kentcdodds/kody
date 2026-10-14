import { routes } from '#universal/routes.ts'

/** Settings fragment for the website republish control. */
export const updatePublicListingSectionId = 'update-public-listing'

export function buildUpdatePublicListingHref(input: {
	username: string
	kodyId: string
}) {
	return `${routes.communityPackageSettings.href(input)}#${updatePublicListingSectionId}`
}

export type CommunityListingBehindHint = {
	pinnedVersion: string | null
	promotedVersion: string | null
	behind: true
	updateHint: string
	updateUrl: string
}

/**
 * Build the discoverability hint when a public catalog listing pin lags the
 * package runtime published commit. Promote auto-syncs active listings; this
 * hint only surfaces when best-effort sync or the scheduled backfill has not
 * caught up yet.
 */
export function buildCommunityListingBehindHint(input: {
	listingPinnedCommit: string
	promotedCommit: string
	pinnedVersion?: string | null
	promotedVersion?: string | null
	updateUrl: string
}): CommunityListingBehindHint | null {
	const pinned = input.listingPinnedCommit.trim()
	const promoted = input.promotedCommit.trim()
	if (!pinned || !promoted || pinned === promoted) return null

	const pinnedVersion = input.pinnedVersion?.trim() || null
	const promotedVersion = input.promotedVersion?.trim() || null
	const pinnedLabel = pinnedVersion ?? shortCommit(pinned)
	const promotedLabel = promotedVersion ?? shortCommit(promoted)

	return {
		pinnedVersion,
		promotedVersion,
		behind: true,
		updateHint: `The public community listing is still pinned to ${pinnedLabel}, while the package runtime is at ${promotedLabel}. Promote normally advances the listing automatically; a background sync is catching this one up. No manual republish step is required.`,
		updateUrl: input.updateUrl,
	}
}

function shortCommit(commit: string) {
	return commit.length > 7 ? commit.slice(0, 7) : commit
}
