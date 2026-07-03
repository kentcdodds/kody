import { z } from 'zod'
import { getCommunityListingWithAggregates } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	buildCommunityPublicUrl,
	communityContentWarning,
	communityGetForkInstructions,
	communityListingAggregatesSchema,
	communityListingStatusSchema,
} from './shared.ts'

export const communityGetCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_get',
		description:
			'Load full detail for one public community listing, including untrusted README content and aggregate ratings.',
		keywords: ['community', 'get', 'listing', 'detail', 'readme', 'package'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			listing_id: z.string().min(1).describe('Community listing id to load.'),
		}),
		outputSchema: communityListingAggregatesSchema.extend({
			listing_id: z.string(),
			name: z.string(),
			kody_id: z.string(),
			description: z.string(),
			tags: z.array(z.string()),
			license: z.string(),
			pinned_commit: z.string(),
			status: communityListingStatusSchema,
			public_url: z.string(),
			published_at: z.string(),
			readme_untrusted: z.string().nullable(),
			content_warning: z.string(),
			fork_instructions: z.string(),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const listing = await getCommunityListingWithAggregates({
				env: ctx.env,
				listingId: args.listing_id,
				includeDelisted: false,
			})
			if (!listing) {
				throw new Error('Community listing not found.')
			}
			return {
				listing_id: listing.id,
				name: listing.name,
				kody_id: listing.kodyId,
				description: listing.description,
				tags: listing.tags,
				license: listing.license,
				pinned_commit: listing.pinnedCommit,
				status: listing.status,
				public_url: buildCommunityPublicUrl(
					ctx.callerContext.baseUrl,
					listing.id,
				),
				published_at: listing.publishedAt,
				average_stars: listing.averageStars,
				rating_count: listing.ratingCount,
				average_adaptation_effort: listing.averageAdaptationEffort,
				fork_count: listing.forkCount,
				readme_untrusted: listing.readmeContent,
				content_warning: communityContentWarning,
				fork_instructions: communityGetForkInstructions,
			}
		},
	},
)
