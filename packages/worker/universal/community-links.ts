import { routes } from '#universal/routes.ts'

const scopedPackageNamePattern = /^@([a-z0-9][a-z0-9._-]*)\//

/**
 * Owner half of a scoped package name (`@owner/kody-id`), or null when the name
 * carries no scope. Listing names carry the owner, so surfaces that only hold a
 * name can still build a canonical URL.
 */
export function parseListingOwnerUsername(name: string) {
	const match = scopedPackageNamePattern.exec(name.trim())
	return match?.[1] ?? null
}

/**
 * The canonical, shareable URL for a community listing: `/@owner/kody-id`.
 * The listing-uuid URL still resolves and redirects here, so it stays the
 * fallback for the surfaces that hold a listing id without its owner's name.
 */
export function getCommunityListingHref(input: {
	listingId: string
	/** Falls back to the owner encoded in `listingName` when omitted. */
	ownerUsername?: string | null
	listingName?: string | null
	kodyId?: string | null
}) {
	const ownerUsername =
		input.ownerUsername ??
		(input.listingName ? parseListingOwnerUsername(input.listingName) : null)
	return ownerUsername && input.kodyId
		? routes.communityPackage.href({
				username: ownerUsername,
				kodyId: input.kodyId,
			})
		: routes.communityDetail.href({ listingId: input.listingId })
}
