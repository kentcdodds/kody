import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { updateSavedPackage } from '#worker/package-registry/repo.ts'

export const setPackageHiddenCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_set_hidden',
		description:
			'Set whether a saved package is hidden from discovery/search by default. Hidden packages are excluded from search results unless the caller opts in with includeHiddenPackages on the public search tool or the meta search capability.',
		keywords: ['package', 'hidden', 'disable', 'visibility', 'search'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: z.string().min(1).describe('Saved package id.'),
			hidden: z
				.boolean()
				.describe(
					'When true, the package is hidden from search discovery by default.',
				),
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			package_id: z.string(),
			hidden: z.boolean(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const changed = await updateSavedPackage(ctx.env.APP_DB, {
				userId: user.userId,
				packageId: args.package_id,
				hidden: args.hidden,
			})
			if (!changed) {
				throw new Error('Saved package not found for this user.')
			}
			return {
				ok: true as const,
				package_id: args.package_id,
				hidden: args.hidden,
			}
		},
	},
)
