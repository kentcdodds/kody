import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { deleteSavedPackageProjection } from '#worker/package-registry/service.ts'

export const deletePackageCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_delete',
		description:
			'Delete a saved package projection for the signed-in user. This removes the saved package from discovery. Repo-backed source cleanup is handled separately.',
		keywords: ['package', 'delete', 'remove'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			package_id: z.string().min(1).describe('Saved package id to delete.'),
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			package_id: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const existing = await getSavedPackageById(ctx.env.APP_DB, {
				userId: user.userId,
				packageId: args.package_id,
			})
			if (!existing) {
				throw new Error('Saved package not found for this user.')
			}
			await deleteSavedPackageProjection({
				env: ctx.env,
				userId: user.userId,
				packageId: args.package_id,
			})
			return {
				ok: true as const,
				package_id: args.package_id,
			}
		},
	},
)
