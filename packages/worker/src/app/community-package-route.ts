import { createMatcher } from 'remix/route-pattern/match'
import {
	getCommunityPackageHref,
	resolveCommunityPackageUrl,
} from '#worker/community/package-url.ts'
import { routes } from '#universal/routes.ts'

const communityDetailMatcher = createMatcher(routes.communityDetail.pattern)
const communityPackageMatcher = createMatcher(routes.communityPackage.pattern)

export type CommunityListingRouteTarget =
	| { kind: 'listing'; listingId: string }
	// The URL is stale (a rename moved it) and the visitor belongs at `to`.
	| { kind: 'redirect'; to: string }

/**
 * Resolve a listing page URL in either public shape: the canonical
 * `/@owner/kody-id` and the listing-uuid `/community/:listingId` it replaced.
 * Shared by the page handlers, the JSON companions, and the frame renderer so
 * one URL never resolves differently depending on which entered it.
 */
export async function resolveCommunityListingRoute(input: {
	env: Env
	url: URL
}): Promise<CommunityListingRouteTarget | null> {
	const listingId = communityDetailMatcher.match(input.url)?.params.listingId
	if (listingId) return { kind: 'listing', listingId }

	const params = communityPackageMatcher.match(input.url)?.params
	if (!params) return null

	const target = await resolveCommunityPackageUrl({
		db: input.env.APP_DB,
		username: params.username,
		kodyId: params.kodyId,
	})
	if (!target) return null
	if (target.kind === 'redirect') {
		return { kind: 'redirect', to: getCommunityPackageHref(target) }
	}
	return { kind: 'listing', listingId: target.listingId }
}

/**
 * The canonical path for a listing, or null when the owner/`kody.id` pair does
 * not lead back to it. The owner half comes from the listing's scoped name,
 * which a failed republish can leave stale, so a caller redirecting permanently
 * has to know the destination actually resolves — a cached redirect to a 404
 * would outlive the data fix.
 */
export async function resolveCanonicalListingPath(input: {
	env: Env
	listingId: string
	ownerUsername: string
	kodyId: string
}): Promise<string | null> {
	const target = await resolveCommunityPackageUrl({
		db: input.env.APP_DB,
		username: input.ownerUsername,
		kodyId: input.kodyId,
	})
	if (target?.listingId !== input.listingId) return null
	return getCommunityPackageHref(target)
}
