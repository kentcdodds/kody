import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { buildIntegrationUsageUrl } from '#worker/integrations/package-access.ts'
import { lockIntegrationToPackage } from '#worker/integrations/service.ts'

const outputSchema = z.object({
	name: z.string(),
	usage_mode: z.literal('packages'),
	allowed_package_ids: z.array(z.string()),
	usage_url: z.string(),
})

export const integrationLockCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationLock',
		description:
			'Lock an OAuth integration connection to a package so only that package (and any previously granted packages) can call createAuthenticatedFetch / token refresh. Execute and other packages are denied. Agents can lock; unlocking or removing a grant is website-only at /account/integrations/:name. This capability cannot loosen usage. integrationSave still cannot change usageMode.',
		keywords: [
			'integration',
			'oauth',
			'lock',
			'package',
			'usage',
			'restrict',
			'grant',
			'token',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			name: z
				.string()
				.min(1)
				.describe('Saved integration connection name (provider key).'),
			package_id: z
				.string()
				.min(1)
				.describe('Saved package id that may use this integration.'),
		}),
		outputSchema,
		async handler(
			args: { name: string; package_id: string },
			ctx: CapabilityContext,
		) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				const updated = await lockIntegrationToPackage({
					env: ctx.env,
					userId: user.userId,
					name: args.name,
					packageId: args.package_id,
				})
				return {
					name: updated.name,
					usage_mode: 'packages' as const,
					allowed_package_ids: updated.allowedPackageIds,
					usage_url: buildIntegrationUsageUrl({
						baseUrl: ctx.callerContext.baseUrl,
						name: updated.name,
					}),
				}
			} catch (error) {
				throw new McpCallerError(
					error instanceof Error
						? error.message
						: 'Unable to lock this integration to a package.',
					{ cause: error },
				)
			}
		},
	},
)
