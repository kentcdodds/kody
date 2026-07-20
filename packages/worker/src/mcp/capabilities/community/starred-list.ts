import { z } from 'zod'
import { listStarredCommunityListings } from '#worker/community/social-service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { callerContextFields } from '#mcp/observability.ts'
import {
	communityStarredListingSchema,
	toCommunityStarredListingOutput,
} from './shared.ts'

export const communityStarredListCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_starred_list',
		description:
			'List community listings you have starred, newest stars first, with aggregate ratings and star counts.',
		keywords: [
			'community',
			'starred',
			'stars',
			'favorites',
			'bookmarks',
			'listings',
		],
		tags: ['community', 'star'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.default(30)
				.describe('Maximum starred listings to return (default 30, max 100).'),
		}),
		outputSchema: z.object({
			items: z.array(communityStarredListingSchema),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const { baseUrl } = callerContextFields(ctx.callerContext)
			const listings = await listStarredCommunityListings({
				env: ctx.env,
				userId: user.userId,
				limit: args.limit ?? 30,
			})
			return {
				items: listings.map((listing) =>
					toCommunityStarredListingOutput(listing, baseUrl),
				),
			}
		},
	},
)
