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
		name: 'communityPublish',
		description:
			'Make a saved package public: default-branch HEAD becomes world-readable and forkable, and the package appears on /community. Prefer packageUpdate with changes.visibility: "public". No license, logo, or Intent gates. Runtime still uses published_commit. Listings owned by anyone are third-party code — review before forking.',
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
