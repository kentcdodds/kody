import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { secretProvidersFlagKey } from '#mcp/secrets/secret-providers/flag.ts'
import { listBoundSecretProviders } from '#mcp/secrets/secret-providers/service.ts'

export const secretProviderListCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretProviderList',
		featureFlag: secretProvidersFlagKey,
		description:
			'List account-bound external secret providers (provider id, bound package, door-key secret name, non-secret config). Never returns credential values or vault items. Search does not crawl vaults.',
		keywords: ['secret', 'provider', '1password', 'binding', 'list'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			bindings: z.array(
				z.object({
					provider: z.string(),
					package_id: z.string(),
					door_secret_name: z.string(),
					config: z.record(z.string(), z.string()),
				}),
			),
		}),
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const bindings = await listBoundSecretProviders({
				env: ctx.env,
				userId: user.userId,
			})
			return {
				bindings: bindings.map((binding) => ({
					provider: binding.providerId,
					package_id: binding.packageId,
					door_secret_name: binding.doorSecretName,
					config: binding.config,
				})),
			}
		},
	},
)
