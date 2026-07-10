import { type Action } from 'remix/router'
import {
	buildCommunityIconFallbackSvg,
	getCommunityIconObject,
} from '#worker/community/community-icon.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { type routes } from '#app/routes.ts'

const communityIconCacheControl = 'public, max-age=3600'

export function createCommunityIconHandler(env: Env) {
	return {
		middleware: [],
		async handler({ params }) {
			const listing = await getCommunityListingById(env.APP_DB, {
				listingId: params.listingId,
				includeDelisted: false,
			})
			if (!listing || listing.pinnedCommit !== params.pinnedCommit) {
				return new Response('Not found', { status: 404 })
			}

			try {
				const { descriptor, object } = await getCommunityIconObject({
					env,
					listing,
				})
				return new Response(object.body, {
					headers: {
						'Cache-Control': communityIconCacheControl,
						'Content-Length': String(descriptor.byteLength),
						'Content-Type': descriptor.contentType,
						ETag: object.httpEtag,
						'X-Content-Type-Options': 'nosniff',
					},
				})
			} catch (error) {
				console.error('community-icon-load-failed', listing.id, error)
				return new Response(buildCommunityIconFallbackSvg(listing.name), {
					headers: {
						'Cache-Control': 'no-store',
						'Content-Security-Policy': "default-src 'none'; sandbox",
						'Content-Type': 'image/svg+xml; charset=utf-8',
						'X-Content-Type-Options': 'nosniff',
					},
				})
			}
		},
	} satisfies Action<typeof routes.communityDetailIcon>
}
