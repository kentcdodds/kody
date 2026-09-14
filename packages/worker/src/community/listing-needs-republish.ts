/**
 * Owner "Needs republish" is commit-based: the community listing pin is
 * behind the package runtime published commit. `communityPublish` stamps the
 * pin to that SHA, then `updateSavedPackage` bumps `saved_packages.updated_at`
 * after `listing.published_at`, so comparing those timestamps resticks the
 * badge even when the pin already matches HEAD / published_commit.
 *
 * HEAD-ahead-of-published is a different signal (listing `sourceAhead`). This
 * flag is only "listing pin behind published_commit".
 */
export function listingNeedsRepublish(input: {
	listingPinnedCommit: string | null | undefined
	sourcePublishedCommit: string | null | undefined
}): boolean {
	const pin = input.listingPinnedCommit?.trim()
	const published = input.sourcePublishedCommit?.trim()
	if (!pin || !published) return false
	return pin !== published
}
