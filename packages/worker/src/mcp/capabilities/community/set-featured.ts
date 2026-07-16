import { z } from 'zod'
import { setCommunityListingFeatured } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { auditAdminCapabilityInvocation } from '#mcp/capabilities/admin/admin-shared.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { communityListingStatusSchema } from './shared.ts'

export const communitySetFeaturedCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_set_featured',
		description:
			'Admin-only curation: mark a trusted community listing as an onboarding starter package, or remove the mark. Featured listings are offered for one-click install during onboarding, so featuring requires the listing to be trusted at its current commit; an owner republish drops the listing from onboarding until an admin re-trusts it.',
		keywords: [
			'community',
			'featured',
			'onboarding',
			'starter',
			'curate',
			'admin',
			'listing',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		requiredRole: 'admin',
		inputSchema: z.object({
			listing_id: z
				.string()
				.min(1)
				.describe('Community listing id to mark or unmark as featured.'),
			featured: z
				.boolean()
				.describe(
					'True to feature this trusted listing in onboarding; false to remove it.',
				),
		}),
		outputSchema: z.object({
			listing_id: z.string(),
			name: z.string(),
			status: communityListingStatusSchema,
			trusted: z.boolean(),
			featured: z.boolean(),
			featured_at: z.string().nullable(),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			return await auditAdminCapabilityInvocation(
				ctx,
				'community_set_featured',
				async () => {
					const listing = await setCommunityListingFeatured({
						env: ctx.env,
						listingId: args.listing_id,
						featured: args.featured,
					})
					return {
						listing_id: listing.id,
						name: listing.name,
						status: listing.status,
						trusted: listing.trusted,
						featured: listing.featured,
						featured_at: listing.featuredAt,
					}
				},
				{
					successReason: (result) =>
						`listing_id=${result.listing_id};featured=${result.featured}`,
				},
			)
		},
	},
)
