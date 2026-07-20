import { z } from 'zod'
import { unstarCommunityListing } from '#worker/community/social-service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const communityUnstarCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_unstar',
		description:
			'Remove your star from a community listing. Unstarring when not starred is a no-op.',
		keywords: ['community', 'unstar', 'favorite', 'bookmark', 'listing'],
		tags: ['community', 'star'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			listing_id: z.string().min(1).describe('Community listing id to unstar.'),
		}),
		outputSchema: z.object({
			starred: z.literal(false),
			listing_id: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			await unstarCommunityListing({
				env: ctx.env,
				userId: user.userId,
				listingId: args.listing_id,
			})
			return {
				starred: false as const,
				listing_id: args.listing_id,
			}
		},
	},
)
