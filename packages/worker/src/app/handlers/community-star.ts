import { z } from 'zod'
import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { toPublicCommunityStargazer } from '#app/community-public.ts'
import { type routes } from '#universal/routes.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	listCommunityStargazersForListing,
	starCommunityListing,
	unstarCommunityListing,
} from '#worker/community/social-service.ts'
import { jsonResponse } from '#worker/json-response.ts'

const starBodySchema = z.object({
	starred: z.boolean(),
})

export function createCommunityStarApiPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			const body = await request.json().catch(() => null)
			const parsed = starBodySchema.safeParse(body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			try {
				if (parsed.data.starred) {
					await starCommunityListing({
						env,
						userId: user.mcpUser.userId,
						listingId: params.listingId,
					})
				} else {
					await unstarCommunityListing({
						env,
						userId: user.mcpUser.userId,
						listingId: params.listingId,
					})
				}
				const { totalStars } = await listCommunityStargazersForListing({
					env,
					listingId: params.listingId,
					limit: 1,
				})
				return jsonResponse({
					ok: true,
					starred: parsed.data.starred,
					starCount: totalStars,
				})
			} catch (error) {
				if (error instanceof CommunityActionError) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				console.error('Community star update failed:', error)
				return jsonResponse(
					{ ok: false, error: 'Unable to update star status.' },
					500,
				)
			}
		},
	} satisfies Action<typeof routes.communityStarApiPost>
}

export function createCommunityStargazersApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const result = await listCommunityStargazersForListing({
				env,
				listingId: params.listingId,
				limit: 20,
			})
			return jsonResponse({
				ok: true,
				totalStars: result.totalStars,
				stargazers: result.stargazers.map(toPublicCommunityStargazer),
			})
		},
	} satisfies Action<typeof routes.communityStargazersApi>
}
