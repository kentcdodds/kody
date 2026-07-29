import { z } from 'zod'
import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { type routes } from '#app/routes.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { setCommunityListingTrusted } from '#worker/community/service.ts'
import { jsonResponse } from '#worker/json-response.ts'

const communityTrustPostSchema = z.object({
	trusted: z.boolean(),
})

export function createCommunityTrustApiPostHandler(env: Env) {
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
			const parsed = communityTrustPostSchema.safeParse(body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			try {
				const listing = await setCommunityListingTrusted({
					env,
					adminUserId: actor.mcpUser.userId,
					listingId: params.listingId,
					trusted: parsed.data.trusted,
				})
				void logAuditEvent({
					db: env.APP_DB,
					category: 'admin',
					action: 'community_listing_trust',
					result: 'success',
					email: actor.email,
					ip: getRequestIp(request) ?? undefined,
					path: new URL(request.url).pathname,
					reason: `listing_id=${listing.id};trusted=${parsed.data.trusted}`,
				})
				// Featured is derived from trust (featured_at survives revocation),
				// so the client needs the recomputed flag to stay in sync.
				return jsonResponse({
					ok: true,
					trusted: listing.trusted,
					featured: listing.featured,
				})
			} catch (error) {
				if (error instanceof CommunityActionError) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				console.error('Community trust update failed:', error)
				return jsonResponse(
					{ ok: false, error: 'Unable to update trust for this listing.' },
					500,
				)
			}
		},
	} satisfies Action<typeof routes.communityTrustApiPost>
}
