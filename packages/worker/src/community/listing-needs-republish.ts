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

/**
 * Profile `listing=ahead` filter. Same commit comparison as
 * `listingNeedsRepublish`, joined through the owner's package source so a
 * foreign `entity_sources` row cannot leak a commit into another user's list.
 */
export const listingNeedsRepublishSql = `EXISTS (
	SELECT 1 FROM community_listings AS cl
	JOIN entity_sources AS es
		ON es.id = saved_packages.source_id
		AND es.user_id = saved_packages.user_id
		AND es.entity_kind = 'package'
		AND es.entity_id = saved_packages.id
	WHERE cl.owner_user_id = saved_packages.user_id
		AND cl.status = 'active'
		AND cl.package_id = saved_packages.id
		AND es.published_commit IS NOT NULL
		AND cl.pinned_commit != es.published_commit
)`
