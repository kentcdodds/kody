import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { packageSummarySchema } from './shared.ts'

export const getPackageCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_get',
		description:
			'Load one saved package metadata record for the signed-in user by package id.',
		keywords: ['package', 'get', 'read', 'metadata'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: z.string().min(1),
		}),
		outputSchema: packageSummarySchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const saved = await getSavedPackageById(ctx.env.APP_DB, {
				userId: user.userId,
				packageId: args.package_id,
			})
			if (!saved) {
				throw new Error('Saved package not found for this user.')
			}
			return {
				package_id: saved.id,
				kody_id: saved.kodyId,
				name: saved.name,
				description: saved.description,
				tags: saved.tags,
				has_app: saved.hasApp,
				source_id: saved.sourceId,
				created_at: saved.createdAt,
				updated_at: saved.updatedAt,
			}
		},
	},
)
