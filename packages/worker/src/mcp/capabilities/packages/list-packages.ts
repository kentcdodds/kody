import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	packageScopeInputDescription,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import { listSavedPackagesWithCommunityProvenanceByUserId } from '#worker/package-registry/repo.ts'
import {
	packageSummaryWithCommunityProvenanceSchema,
	toPackageSummaryWithCommunityProvenance,
} from './shared.ts'

export const listPackagesCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_list',
		description:
			'List saved packages for the signed-in user, including community-fork source listing provenance, so agents can discover package ids and kody ids for later execution, editing, or UI opening.',
		keywords: ['package', 'list', 'saved packages'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_scope: z
				.string()
				.min(1)
				.optional()
				.describe(packageScopeInputDescription),
		}),
		outputSchema: z.object({
			packages: z.array(packageSummaryWithCommunityProvenanceSchema),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(
				ctx.env,
				user,
				args.package_scope,
			)
			const packages = await listSavedPackagesWithCommunityProvenanceByUserId(
				ctx.env.APP_DB,
				{
					userId: owner.ownerUserId,
				},
			)
			return {
				packages: packages.map(toPackageSummaryWithCommunityProvenance),
			}
		},
	},
)
