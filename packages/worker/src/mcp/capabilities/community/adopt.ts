import { z } from 'zod'
import { adoptCommunityFork } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const communityForkAdoptCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_fork_adopt',
		description:
			'Mark a community-forked package as reviewed and trusted by you. Adoption keeps fork provenance but grants self-authored-like read/use access to your user secrets (mutations still need an allowed_packages grant). Agents must actually review the package source (repo session or fork files) before calling this, include what was reviewed in `review_summary`, and tell the user the fork was adopted.',
		keywords: [
			'community',
			'fork',
			'adopt',
			'review',
			'trust',
			'package',
			'secret',
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
			review_summary: z
				.string()
				.min(10)
				.describe(
					'What you reviewed in the forked code and why it is trusted enough to treat as your own for user-secret read/use.',
				),
		}),
		outputSchema: z.object({
			adopted: z.literal(true),
			already_adopted: z.boolean(),
			package_id: z.string(),
			kody_id: z.string(),
			listing_id: z.string(),
			origin_commit: z.string(),
			adopted_at: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await adoptCommunityFork({
				env: ctx.env,
				userId: user.userId,
				packageId: args.package_id,
				kodyId: args.kody_id,
				reviewSummary: args.review_summary,
			})
			return {
				adopted: true as const,
				already_adopted: result.alreadyAdopted,
				package_id: result.packageId,
				kody_id: result.kodyId,
				listing_id: result.listingId,
				origin_commit: result.originCommit,
				adopted_at: result.adoptedAt,
			}
		},
	},
)
