import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
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
			'Make a public package private: unlist it from /community and 404 public URLs (existing forks keep their copies). Prefer package_update with changes.visibility: "private" and confirm_name matching the package slug. Delisted listings cannot be unpublished by the owner.',
		keywords: ['community', 'unpublish', 'delist', 'remove', 'listing'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			listing_id: z
				.string()
				.min(1)
				.describe('Community listing id to unpublish.'),
			confirm_name: z
				.string()
				.min(1)
				.describe(
					'Must equal the package slug (URL name / kody id). Confirm with the user first: going private 404s public URLs and unlists the catalog; existing forks keep their copies.',
				),
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
			const listing = await getCommunityListingById(ctx.env.APP_DB, {
				listingId: args.listing_id,
				includeDelisted: true,
			})
			if (!listing || listing.ownerUserId !== owner.ownerUserId) {
				throw new McpCallerError(
					`Community listing "${args.listing_id}" was not found.`,
				)
			}
			if (args.confirm_name.trim() !== listing.kodyId) {
				throw new McpCallerError(
					`Making this package private unlists it from /community and 404s public URLs. Existing forks keep their copies. Confirm with the user, then pass confirm_name: "${listing.kodyId}" (the package slug).`,
				)
			}
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
