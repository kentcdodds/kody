import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { secretProvidersFlagKey } from '#mcp/secrets/secret-providers/flag.ts'
import { unbindSecretProvider } from '#mcp/secrets/secret-providers/service.ts'

export const secretProviderUnbindCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretProviderUnbind',
		featureFlag: secretProvidersFlagKey,
		description:
			'Remove the account binding for an external secret provider id. Unbind and rebind to a different package drop every grant for that provider. Does not return secret values.',
		keywords: ['secret', 'provider', 'unbind', 'disconnect'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			provider: z.string().min(1).describe('Provider id to unbind.'),
		}),
		outputSchema: z.object({
			provider: z.string(),
			unbound: z.boolean(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await unbindSecretProvider({
				env: ctx.env,
				userId: user.userId,
				providerId: args.provider,
			})
			return { provider: result.providerId, unbound: true }
		},
	},
)
