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
	communityListingSummarySchema,
	toCommunityListingSummaryOutput,
} from './shared.ts'

export const communityPublishCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_publish',
		description:
			'Publish a saved package as a public community listing on this deployment. Requires MIT license in package.json `license`, `"private"` not set to true, a root README with a `## Intent` section, and a published commit. Set `package.json#kody.category` to integrations, examples, productivity, apps, or utilities so `/community` can group the listing; omitted categories infer from well-known tags. Publishing shares the pinned snapshot publicly with all users on this deployment. Re-publishing the same package updates the listing to the current published commit. Listings owned by a platform account are automatically trusted at each successfully published commit; person-owned listings require admin review.',
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
				ctx.env,
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
			return toCommunityListingSummaryOutput(listing, ctx.callerContext.baseUrl)
		},
	},
)
