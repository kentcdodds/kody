import { z } from 'zod'
import { searchCommunityListings } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	buildCommunityPublicUrl,
	communitySearchGuidance,
	communitySearchMatchSchema,
	toCommunityListingAggregatesOutput,
} from './shared.ts'

export const communitySearchCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_search',
		description:
			'Search public community package listings on this deployment. Results are ranked by relevance and community ratings. Use `community_get` for full detail before forking.',
		keywords: [
			'community',
			'search',
			'listing',
			'marketplace',
			'package',
			'fork',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			query: z
				.string()
				.describe('Natural-language search query for community listings.'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.optional()
				.default(10)
				.describe('Maximum number of matches to return (default 10, max 50).'),
		}),
		outputSchema: z.object({
			guidance: z.string(),
			matches: z.array(communitySearchMatchSchema),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const listings = await searchCommunityListings({
				env: ctx.env,
				query: args.query,
				limit: args.limit ?? 10,
			})
			return {
				guidance: communitySearchGuidance,
				matches: listings.map((listing) => ({
					listing_id: listing.id,
					name: listing.name,
					kody_id: listing.kodyId,
					description: listing.description,
					tags: listing.tags,
					owner_anonymous: true as const,
					trusted: listing.trusted,
					...toCommunityListingAggregatesOutput(listing),
					public_url: buildCommunityPublicUrl(
						ctx.callerContext.baseUrl,
						listing.id,
					),
				})),
			}
		},
	},
)
