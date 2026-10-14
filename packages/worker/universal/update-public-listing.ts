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
 * package runtime published commit. Listings do not auto-follow promote;
 * owners must call communityPublish (or the website Update public listing
 * action) to move the pin.
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
		updateHint: `The public community listing is still pinned to ${pinnedLabel}, while the package runtime is at ${promotedLabel}. Publish and promote do not move the catalog listing. Call communityPublish (or use Update public listing on the package settings page) to republish the listing to the current published commit.`,
		updateUrl: input.updateUrl,
	}
}

function shortCommit(commit: string) {
	return commit.length > 7 ? commit.slice(0, 7) : commit
}
