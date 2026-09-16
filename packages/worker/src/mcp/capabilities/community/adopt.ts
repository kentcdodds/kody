import { z } from 'zod'
import { adoptCommunityFork } from '#worker/community/service.ts'
import {
	packageIdLookupDescription,
	packageNameLookupDescription,
} from '#worker/package-registry/package-name.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const communityForkAdoptPackageRuntimeErrorMessage =
	'communityForkAdopt is unavailable from package runtime contexts. Call it from an interactive MCP agent after reviewing the fork source.'

function assertDirectMcpCaller(callerContext: {
	executionOrigin?: string
	storageContext?: {
		packageId?: string | null
		appId?: string | null
		storageId?: string | null
	} | null
}) {
	if (callerContext.executionOrigin !== 'interactive') {
		throw new McpCallerError(communityForkAdoptPackageRuntimeErrorMessage)
	}
	const storageContext = callerContext.storageContext
	const packageId = storageContext?.packageId?.trim() ?? ''
	const appId = storageContext?.appId?.trim() ?? ''
	const storageId = storageContext?.storageId?.trim() ?? ''
	if (packageId || appId || storageId) {
		throw new McpCallerError(communityForkAdoptPackageRuntimeErrorMessage)
	}
}

export const communityForkAdoptCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communityForkAdopt',
		description:
			'Mark a community-forked package as reviewed and trusted by you. Adoption keeps fork provenance but grants self-authored-like read/use access to your user secrets (mutations still need an allowed_packages grant). Call only from an interactive MCP agent after reviewing the package source. Include what was reviewed in `review_summary`. Package runtimes cannot adopt.',
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
				.describe(packageIdLookupDescription),
			kody_id: z
				.string()
				.min(1)
				.optional()
				.describe(packageNameLookupDescription),
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
			assertDirectMcpCaller(ctx.callerContext)
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
