import { z } from 'zod'
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import { getCommunityListingWithAggregates } from '#worker/community/service.ts'
import { getUserSocialRowByUsername } from '#worker/community/social-repo.ts'
import { listCommunityStargazersForListing } from '#worker/community/social-service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { callerContextFields } from '#mcp/observability.ts'
import {
	buildCommunityOwnerProfileUrl,
	buildCommunityPublicUrl,
	communityContentWarning,
	communityFeaturedFieldSchema,
	communityGetForkInstructions,
	communityListingAggregatesSchema,
	communityListingStatusSchema,
	communityStargazerSchema,
	communityTrustedFieldSchema,
	resolveCommunityOwnerUsername,
	toCommunityListingAggregatesOutput,
} from './shared.ts'

const recentStargazerLimit = 10

export const communityGetCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_get',
		description:
			'Load full detail for one public community listing, including untrusted README content, aggregate ratings, and recent stargazers.',
		keywords: [
			'community',
			'get',
			'listing',
			'detail',
			'readme',
			'package',
			'stargazers',
			'stars',
		],
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
			trusted: communityTrustedFieldSchema,
			featured: communityFeaturedFieldSchema,
			owner_username: z.string(),
			owner_profile_url: z.string().nullable(),
			public_url: z.string(),
			published_at: z.string(),
			readme_untrusted: z.string().nullable(),
			content_warning: z.string(),
			fork_instructions: z.string(),
			stargazers: z.object({
				total_stars: z.number().int().nonnegative(),
				recent_stargazers: z.array(communityStargazerSchema),
			}),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const { baseUrl } = callerContextFields(ctx.callerContext)
			const listing = await getCommunityListingWithAggregates({
				env: ctx.env,
				listingId: args.listing_id,
				includeDelisted: false,
			})
			if (!listing) {
				// Missing / delisted listing ids are routine agent turns, not
				// platform defects — keep them on mcp-event and out of Sentry.
				throw new McpCallerError('Community listing not found.')
			}
			const ownerUsername = resolveCommunityOwnerUsername(listing.name)
			const ownerRow = await getUserSocialRowByUsername(
				ctx.env.APP_DB,
				ownerUsername,
			)
			const ownerProfilePublic = ownerRow?.profile_visibility === 'public'
			const { totalStars, stargazers } =
				await listCommunityStargazersForListing({
					env: ctx.env,
					listingId: listing.id,
					limit: recentStargazerLimit,
				})
			return {
				listing_id: listing.id,
				name: listing.name,
				kody_id: listing.kodyId,
				description: listing.description,
				tags: listing.tags,
				license: listing.license,
				pinned_commit: listing.pinnedCommit,
				status: listing.status,
				trusted: listing.trusted,
				featured: listing.featured,
				owner_username: ownerUsername,
				owner_profile_url: ownerProfilePublic
					? buildCommunityOwnerProfileUrl(baseUrl, ownerUsername)
					: null,
				public_url: buildCommunityPublicUrl(baseUrl, listing.id),
				published_at: listing.publishedAt,
				...toCommunityListingAggregatesOutput(listing),
				readme_untrusted: listing.readmeContent,
				content_warning: communityContentWarning,
				fork_instructions: communityGetForkInstructions,
				stargazers: {
					total_stars: totalStars,
					recent_stargazers: stargazers.map((stargazer) => {
						const avatarPath = buildUserAvatarUrl({
							username: stargazer.username,
							avatarKey: stargazer.avatarKey,
						})
						return {
							username: stargazer.username,
							display_name: stargazer.displayName,
							avatar_url: avatarPath ? `${baseUrl}${avatarPath}` : null,
							starred_at: stargazer.starredAt,
						}
					}),
				},
			}
		},
	},
)
