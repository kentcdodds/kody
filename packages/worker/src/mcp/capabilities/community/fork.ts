import { z } from 'zod'
import { forkCommunityListing } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import {
	communityContentWarning,
	communityForkNextSteps,
	crossScopeReferenceSchema,
} from './shared.ts'

export const communityForkCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_fork',
		description:
			'Fork a community listing into an inert package source in your scope. The fork cannot run until you review the code and publish through a repo session. Pass `kody_id` when you already have a package with the same id.',
		keywords: ['community', 'fork', 'copy', 'listing', 'package', 'import'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			listing_id: z.string().min(1).describe('Community listing id to fork.'),
			kody_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional kody id override when the caller already has a package with the same id.',
				),
		}),
		outputSchema: z.object({
			fork_id: z.string(),
			package_id: z.string(),
			source_id: z.string(),
			target_kody_id: z.string(),
			target_name: z.string(),
			origin_commit: z.string(),
			files_count: z.number().int().nonnegative(),
			cross_scope_references: z.array(crossScopeReferenceSchema),
			next_steps: z.string(),
			content_warning: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const expectedPackageScope = await getMcpUserPackageScope(
				ctx.env.APP_DB,
				user,
			)
			const result = await forkCommunityListing({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: user.userId,
				expectedPackageScope,
				listingId: args.listing_id,
				kodyId: args.kody_id,
				actor: 'agent',
			})
			return {
				fork_id: result.forkId,
				package_id: result.packageId,
				source_id: result.sourceId,
				target_kody_id: result.targetKodyId,
				target_name: result.targetName,
				origin_commit: result.originCommit,
				files_count: result.filesCount,
				cross_scope_references: result.crossScopeReferences,
				next_steps: communityForkNextSteps,
				content_warning: communityContentWarning,
			}
		},
	},
)
