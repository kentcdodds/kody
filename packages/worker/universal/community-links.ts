import { routes } from '#universal/routes.ts'

/** Public invite for the Kody community Discord. */
export const kodyDiscordInviteUrl = 'https://kcd.im/kody-discord'

/** Kent's public issue-triage package — linked from user error-rate mail. */
export const kodyIssueTriageListingPath = '/@kentcdodds/kody-issue-triage'

const scopedPackageNamePattern = /^@([a-z0-9][a-z0-9._-]*)\//

/** Platform account that owns official first-party `@kody/*` listings. */
export const officialCommunityOwnerUsername = 'kody'

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
 * Official / first-party catalog listings (`@kody/*`). These skip the
 * third-party install confirm — they are implicitly trusted.
 */
export function isOfficialCommunityListing(input: {
	name?: string | null
	ownerUsername?: string | null
}) {
	const owner =
		input.ownerUsername?.trim().toLowerCase() ||
		parseListingOwnerUsername(input.name ?? '') ||
		''
	return owner === officialCommunityOwnerUsername
}

/** Canonical `/@owner/kody-id` for a scoped package name, or null. */
export function getCommunityPackageHrefFromName(name: string) {
	const ownerUsername = parseListingOwnerUsername(name)
	if (!ownerUsername) return null
	const kodyId = name.trim().slice(`@${ownerUsername}/`.length)
	if (!kodyId) return null
	return routes.communityPackage.href({
		username: ownerUsername,
		kodyId,
	})
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
