import { z } from 'zod'
import {
	listCommunityStargazersForListing,
	starCommunityListing,
} from '#worker/community/social-service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const communityStarCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_star',
		description:
			'Star a public community listing. Re-starring is a no-op and returns the current star count.',
		keywords: ['community', 'star', 'favorite', 'bookmark', 'listing'],
		tags: ['community', 'star'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			listing_id: z.string().min(1).describe('Community listing id to star.'),
		}),
		outputSchema: z.object({
			starred: z.literal(true),
			listing_id: z.string(),
			star_count: z.number().int().nonnegative(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			await starCommunityListing({
				env: ctx.env,
				userId: user.userId,
				listingId: args.listing_id,
			})
			const { totalStars } = await listCommunityStargazersForListing({
				env: ctx.env,
				listingId: args.listing_id,
				limit: 1,
			})
			return {
				starred: true as const,
				listing_id: args.listing_id,
				star_count: totalStars,
			}
		},
	},
)
