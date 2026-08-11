import { loadCommunityDetailData } from '#app/community-data.ts'
import { resolveCommunityListingRoute } from '#app/community-package-route.ts'
import { renderCommunityDetailContentHtml } from '#app/community-detail-content.tsx'
import { COMMUNITY_DETAIL_TARGET } from '#universal/community-frame-constants.ts'
import { registerFrame } from '#app/frame-registry.ts'
import { routes } from '#universal/routes.ts'

registerFrame(COMMUNITY_DETAIL_TARGET, {
	routes: [routes.communityPackage, routes.communityDetail],
	render: async ({ request, env, url }) => {
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
			ownerProfilePublic: detail.ownerProfilePublic,
			loggedIn: detail.loggedIn,
			viewerFollowsOwner: detail.viewerFollowsOwner,
			viewerIsOwner: detail.viewerIsOwner,
			returnTo: url.pathname,
			followError: url.searchParams.get('followError'),
		})
	},
})
