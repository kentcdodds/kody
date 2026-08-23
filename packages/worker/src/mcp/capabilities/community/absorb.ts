import { z } from 'zod'
import { absorbCommunityForkUpstream } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const communityForkAbsorbCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_fork_absorb',
		description:
			"Record that a community-forked package has absorbed the source listing's current pinned commit. Call this after reviewing the newer listing snapshot and publishing relevant changes into the fork. Does not copy files; it only clears the listing-ahead flag.",
		keywords: [
			'community',
			'fork',
			'absorb',
			'upstream',
			'update',
			'listing',
			'package',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Saved package id (UUID). Provide exactly one of package_id or kody_id.',
				),
			kody_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Package kody id in your account. Provide exactly one of package_id or kody_id.',
				),
		}),
		outputSchema: z.object({
			absorbed: z.literal(true),
			already_absorbed: z.boolean(),
			package_id: z.string(),
			kody_id: z.string(),
			listing_id: z.string(),
			origin_commit: z.string(),
			listing_pinned_commit: z.string(),
			listing_ahead: z.literal(false),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await absorbCommunityForkUpstream({
				env: ctx.env,
				userId: user.userId,
				packageId: args.package_id,
				kodyId: args.kody_id,
			})
			return {
				absorbed: true as const,
				already_absorbed: result.alreadyAbsorbed,
				package_id: result.packageId,
				kody_id: result.kodyId,
				listing_id: result.listingId,
				origin_commit: result.originCommit,
				listing_pinned_commit: result.listingPinnedCommit,
				listing_ahead: false as const,
			}
		},
	},
)
