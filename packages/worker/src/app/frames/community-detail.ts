import { loadCommunityDetailData } from '#app/community-data.ts'
import {
	buildSourceAheadPublishHref,
	renderCommunityDetailContentHtml,
} from '#app/community-detail-content.tsx'
import { resolveCommunityListingRoute } from '#app/community-package-route.ts'
import { registerFrame } from '#app/frame-registry.ts'
import { loadPackagePage, packagePageIsPrivate } from '#app/package-page.ts'
import { type PublicCommunityListing } from '#app/community-public.ts'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import { COMMUNITY_DETAIL_TARGET } from '#universal/community-frame-constants.ts'
import { routes } from '#universal/routes.ts'
import { createMatcher } from 'remix/route-pattern/match'

const communityPackageMatcher = createMatcher(routes.communityPackage.pattern)

function resolvePublishCompareHref(input: {
	viewerIsOwner: boolean
	listing: PublicCommunityListing | null
}) {
	if (!input.viewerIsOwner || !input.listing?.sourceAhead) return null
	return buildSourceAheadPublishHref({
		username: input.listing.ownerUsername,
		kodyId: input.listing.kodyId,
		headCommit: input.listing.headCommit,
	})
}

registerFrame(COMMUNITY_DETAIL_TARGET, {
	routes: [routes.communityPackage, routes.communityDetail],
	render: async ({ request, env, url }) => {
		const packageParams = communityPackageMatcher.match(url)?.params
		if (packageParams) {
			const page = await loadPackagePage({
				env,
				request,
				username: packageParams.username,
				kodyId: packageParams.kodyId,
			})
			if (page.kind !== 'page') return ''
			const listing = page.listing?.listing ?? null
			return renderCommunityDetailContentHtml({
				listing,
				username: page.username,
				kodyId: page.kodyId,
				description:
					listing?.description ?? page.ownerPackage?.description ?? '',
				isPrivate: packagePageIsPrivate(page),
				ownerProfilePublic: page.ownerProfilePublic,
				loggedIn: page.loggedIn,
				viewerIsOwner: page.viewerIsOwner,
				returnTo: url.pathname,
				publishCompareHref: resolvePublishCompareHref({
					viewerIsOwner: page.viewerIsOwner,
					listing,
				}),
				shareGrant: page.shareGrant,
				hasApp: page.ownerPackage?.hasApp === true,
				iconUrl:
					listing?.iconUrl ??
					resolvePackageListIconUrl({
						username: page.username,
						kodyId: page.kodyId,
						listingId: null,
						listingIconCommit: null,
						publishedCommit: page.ownerPackage?.publishedCommit ?? null,
					}),
			})
		}

		const target = await resolveCommunityListingRoute({ env, url })
		// A frame never redirects: the page handler owns the visitor's URL, and
		// this content is only ever fetched for a URL it already resolved.
		if (target?.kind !== 'listing') {
			return ''
		}
		const detail = await loadCommunityDetailData(env, request, target.listingId)
		if (!detail) {
			return ''
		}
		return renderCommunityDetailContentHtml({
			listing: detail.listing,
			username: detail.listing?.ownerUsername ?? '',
			kodyId: detail.listing?.kodyId ?? '',
			description: detail.listing?.description ?? '',
			isPrivate: false,
			ownerProfilePublic: detail.ownerProfilePublic,
			loggedIn: detail.loggedIn,
			viewerIsOwner: detail.viewerIsOwner,
			returnTo: url.pathname,
			publishCompareHref: resolvePublishCompareHref({
				viewerIsOwner: detail.viewerIsOwner,
				listing: detail.listing,
			}),
			hasApp: detail.ownerPackage?.hasApp === true,
		})
	},
})
