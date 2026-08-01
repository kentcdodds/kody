import { z } from 'zod'
import { unpublishCommunityListing } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	packageScopeInputDescription,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'

export const communityUnpublishCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_unpublish',
		description:
			'Remove one of your active community listings and delete its pinned public snapshot. Delisted listings cannot be unpublished by the owner.',
		keywords: ['community', 'unpublish', 'delist', 'remove', 'listing'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			listing_id: z
				.string()
				.min(1)
				.describe('Community listing id to unpublish.'),
			package_scope: z
				.string()
				.min(1)
				.optional()
				.describe(packageScopeInputDescription),
		}),
		outputSchema: z.object({
			listing_id: z.string(),
			unpublished: z.literal(true),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(
				ctx.env,
				user,
				args.package_scope,
			)
			await unpublishCommunityListing({
				env: ctx.env,
				userId: owner.ownerUserId,
				actorUserId: owner.actorUserId,
				listingId: args.listing_id,
			})
			return {
				listing_id: args.listing_id,
				unpublished: true as const,
			}
		},
	},
)
