import { z } from 'zod'
import { setCommunityListingTrusted } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { auditAdminCapabilityInvocation } from '#mcp/capabilities/admin/admin-shared.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { communityListingStatusSchema } from './shared.ts'

export const communitySetTrustedCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_set_trusted',
		description:
			'Admin-only curation: mark a community listing as trusted at its current pinned commit, or revoke the mark. Trust is pinned to the reviewed commit, so an owner republish automatically drops the effective trusted state until an admin re-reviews.',
		keywords: ['community', 'trusted', 'curate', 'admin', 'review', 'listing'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		requiredRole: 'admin',
		inputSchema: z.object({
			listing_id: z
				.string()
				.min(1)
				.describe('Community listing id to mark or unmark as trusted.'),
			trusted: z
				.boolean()
				.describe(
					'True to mark the current pinned commit as reviewed and trusted; false to revoke.',
				),
		}),
		outputSchema: z.object({
			listing_id: z.string(),
			name: z.string(),
			status: communityListingStatusSchema,
			trusted: z.boolean(),
			trusted_commit: z.string().nullable(),
			pinned_commit: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			return await auditAdminCapabilityInvocation(
				ctx,
				'community_set_trusted',
				async () => {
					const listing = await setCommunityListingTrusted({
						env: ctx.env,
						adminUserId: user.userId,
						listingId: args.listing_id,
						trusted: args.trusted,
					})
					return {
						listing_id: listing.id,
						name: listing.name,
						status: listing.status,
						trusted: listing.trusted,
						trusted_commit: listing.trustedCommit,
						pinned_commit: listing.pinnedCommit,
					}
				},
				{
					successReason: (result) =>
						`listing_id=${result.listing_id};trusted=${result.trusted}`,
				},
			)
		},
	},
)
