import { z } from 'zod'
import { publishCommunityListing } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	packageScopeInputDescription,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import {
	buildCommunityPublicUrl,
	communityListingSummarySchema,
} from './shared.ts'

export const communityPublishCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_publish',
		description:
			'Publish a saved package as a public community listing on this deployment. Requires MIT license in package.json `license`, `"private"` not set to true, a root README with a `## Intent` section, and a published commit. Publishing shares the pinned snapshot publicly with all users on this deployment. Re-publishing the same package updates the listing to the current published commit.',
		keywords: [
			'community',
			'publish',
			'listing',
			'share',
			'marketplace',
			'package',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			package_id: z
				.string()
				.min(1)
				.describe('Saved package id to publish as a community listing.'),
			package_scope: z
				.string()
				.min(1)
				.optional()
				.describe(packageScopeInputDescription),
		}),
		outputSchema: communityListingSummarySchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(
				ctx.env.APP_DB,
				user,
				args.package_scope,
			)
			const listing = await publishCommunityListing({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				actorUserId: owner.actorUserId,
				packageId: args.package_id,
			})
			return {
				listing_id: listing.id,
				name: listing.name,
				kody_id: listing.kodyId,
				description: listing.description,
				license: listing.license,
				pinned_commit: listing.pinnedCommit,
				status: listing.status,
				public_url: buildCommunityPublicUrl(
					ctx.callerContext.baseUrl,
					listing.id,
				),
				published_at: listing.publishedAt,
			}
		},
	},
)
