import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	getSavedPackageById,
	updateSavedPackage,
} from '#worker/package-registry/repo.ts'
import { packageSummarySchema, toPackageSummary } from './shared.ts'

const packageUpdateChangesSchema = z
	.strictObject({
		hidden: z
			.boolean()
			.optional()
			.describe(
				'When true, hide the package from ranked search discovery by default.',
			),
	})
	.refine((changes) => changes.hidden !== undefined, {
		message: 'Provide at least one supported package change.',
	})

export const packageUpdateCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_update',
		description:
			'Update mutable settings for a saved package. Currently supports hidden search-discovery state. Canonical package metadata such as name, description, tags, kody id, app projection, and source remains derived from package.json and must change through package save or publish.',
		keywords: ['package', 'update', 'hidden', 'visibility', 'search'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.strictObject({
			package_id: z.string().min(1).describe('Saved package id.'),
			changes: packageUpdateChangesSchema,
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			package: packageSummarySchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const changed = await updateSavedPackage(ctx.env.APP_DB, {
				userId: user.userId,
				packageId: args.package_id,
				hidden: args.changes.hidden,
			})
			if (!changed) {
				throw new Error('Saved package not found for this user.')
			}
			const savedPackage = await getSavedPackageById(ctx.env.APP_DB, {
				userId: user.userId,
				packageId: args.package_id,
			})
			if (!savedPackage) {
				throw new Error('Saved package not found for this user.')
			}
			return {
				ok: true as const,
				package: toPackageSummary(savedPackage),
			}
		},
	},
)
