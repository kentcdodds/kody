import { z } from 'zod'
import { inspectCommunityForkAdoption } from '#worker/community/service.ts'
import {
	packageIdLookupDescription,
	packageNameLookupDescription,
} from '#worker/package-registry/package-name.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { buildCommunityForkAdoptionHref } from '#universal/community-fork-adoption.ts'

const communityForkAdoptPackageRuntimeErrorMessage =
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
			'Return a website adoption URL for a community-forked package. Adoption keeps fork provenance but grants self-authored-like read/use access to your user secrets (mutations still need an allowed_packages grant). This capability never adopts: only the account owner can adopt, signed in on the package settings page, after reviewing the source. Send the approval_url to the user and wait; never treat this call as adoption.',
		keywords: [
			'community',
			'fork',
			'adopt',
			'review',
			'trust',
			'package',
			'secret',
			'approval',
		],
		readOnly: true,
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
		}),
		outputSchema: z.object({
			status: z.enum(['approval_required', 'already_adopted']),
			package_id: z.string(),
			kody_id: z.string(),
			listing_id: z.string(),
			origin_commit: z.string(),
			adopted_at: z.string().nullable(),
			approval_url: z.string(),
			message: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			assertDirectMcpCaller(ctx.callerContext)
			const state = await inspectCommunityForkAdoption({
				env: ctx.env,
				userId: user.userId,
				packageId: args.package_id,
				kodyId: args.kody_id,
			})
			const approvalUrl = new URL(
				buildCommunityForkAdoptionHref({
					username: state.ownerScope,
					kodyId: state.kodyId,
				}),
				ctx.callerContext.baseUrl,
			).toString()
			return {
				status: state.adoptedAt
					? ('already_adopted' as const)
					: ('approval_required' as const),
				package_id: state.packageId,
				kody_id: state.kodyId,
				listing_id: state.listingId,
				origin_commit: state.originCommit,
				adopted_at: state.adoptedAt,
				approval_url: approvalUrl,
				message: state.adoptedAt
					? `Package "${state.kodyId}" is already adopted.`
					: `Agents cannot adopt community forks. Send the owner to ${approvalUrl} to review the source and adopt "${state.kodyId}" on the website.`,
			}
		},
	},
)
