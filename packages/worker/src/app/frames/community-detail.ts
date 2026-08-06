import { loadCommunityDetailData } from '#app/community-data.ts'
import { renderCommunityDetailContentHtml } from '#app/community-detail-content.tsx'
import { COMMUNITY_DETAIL_TARGET } from '#app/community-frame-constants.ts'
import { registerFrame } from '#app/frame-registry.ts'
import { routes } from '#app/routes.ts'
import { createMatcher } from 'remix/route-pattern/match'

const communityDetailMatcher = createMatcher(routes.communityDetail.pattern)

registerFrame(COMMUNITY_DETAIL_TARGET, {
	route: routes.communityDetail,
	render: async ({ request, env, url }) => {
		const listingId = communityDetailMatcher.match(url)?.params.listingId
		if (!listingId) {
			return ''
		}
		const detail = await loadCommunityDetailData(env, request, listingId)
		if (!detail) {
			return ''
		}
		return renderCommunityDetailContentHtml({
			listing: detail.listing,
			ownerProfilePublic: detail.ownerProfilePublic,
			loggedIn: detail.loggedIn,
			viewerFollowsOwner: detail.viewerFollowsOwner,
			viewerIsOwner: detail.viewerIsOwner,
			returnTo: routes.communityDetail.href({ listingId }),
			followError: new URL(request.url).searchParams.get('followError'),
		})
	},
})
