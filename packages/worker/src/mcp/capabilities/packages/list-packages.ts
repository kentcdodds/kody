import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { packageSummarySchema } from './shared.ts'

export const listPackagesCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_list',
		description:
			'List saved packages for the signed-in user so agents can discover package ids and kody ids for later execution, editing, or UI opening.',
		keywords: ['package', 'list', 'saved packages'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			packages: z.array(packageSummarySchema),
		}),
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const packages = await listSavedPackagesByUserId(ctx.env.APP_DB, {
				userId: user.userId,
			})
			return {
				packages: packages.map((savedPackage) => ({
					package_id: savedPackage.id,
					kody_id: savedPackage.kodyId,
					name: savedPackage.name,
					description: savedPackage.description,
					tags: savedPackage.tags,
					has_app: savedPackage.hasApp,
					source_id: savedPackage.sourceId,
					created_at: savedPackage.createdAt,
					updated_at: savedPackage.updatedAt,
				})),
			}
		},
	},
)
