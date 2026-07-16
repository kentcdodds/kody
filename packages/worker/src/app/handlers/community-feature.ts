import { z } from 'zod'
import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { type routes } from '#app/routes.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { setCommunityListingFeatured } from '#worker/community/service.ts'
import { jsonResponse } from '#worker/json-response.ts'

const communityFeaturePostSchema = z.object({
	featured: z.boolean(),
})

export function createCommunityFeatureApiPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			let actor
			try {
				actor = await requireUserWithRole(request, env, 'admin')
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}

			const body = await request.json().catch(() => null)
			const parsed = communityFeaturePostSchema.safeParse(body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			try {
				const listing = await setCommunityListingFeatured({
					env,
					listingId: params.listingId,
					featured: parsed.data.featured,
				})
				void logAuditEvent({
					db: env.APP_DB,
					category: 'admin',
					action: 'community_listing_feature',
					result: 'success',
					email: actor.email,
					ip: getRequestIp(request) ?? undefined,
					path: new URL(request.url).pathname,
					reason: `listing_id=${listing.id};featured=${parsed.data.featured}`,
				})
				return jsonResponse({ ok: true, featured: listing.featured })
			} catch (error) {
				if (error instanceof CommunityActionError) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				console.error('Community feature update failed:', error)
				return jsonResponse(
					{ ok: false, error: 'Unable to update featuring for this listing.' },
					500,
				)
			}
		},
	} satisfies Action<typeof routes.communityFeatureApiPost>
}
