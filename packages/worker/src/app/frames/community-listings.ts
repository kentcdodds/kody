import { loadCommunityIndexData } from '#app/community-data.ts'
import { renderCommunityListingsContentHtml } from '#app/community-listings-content.tsx'
import { COMMUNITY_LISTINGS_TARGET } from '#universal/community-frame-constants.ts'
import { registerFrame } from '#app/frame-registry.ts'
import { routes } from '#universal/routes.ts'

registerFrame(COMMUNITY_LISTINGS_TARGET, {
	route: routes.community,
	render: async ({ request, env }) => {
		const data = await loadCommunityIndexData(env, request)
		return renderCommunityListingsContentHtml({
			listings: data.listings,
			query: data.query,
		})
	},
})
