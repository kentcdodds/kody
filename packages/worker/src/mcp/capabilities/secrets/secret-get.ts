import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'

export const secretGetCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secret_get',
		description:
			'Resolve a secret value for server-side execution. Use the injected `secrets.get(name, { scope })` or `secrets.require(name, { scope })` helper from execute-time code instead of calling this directly when possible.',
		keywords: ['secret', 'resolve', 'read', 'credential'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			name: z
				.string()
				.min(1)
				.describe('Secret name to resolve from the accessible secret scopes.'),
			scope: z
				.enum(secretScopeValues)
				.optional()
				.describe(
					'Optional scope override. When omitted, resolution uses the default scope precedence order.',
				),
		}),
		outputSchema: z.object({
			found: z.boolean(),
			value: z.string().nullable(),
			scope: z.enum(secretScopeValues).nullable(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return resolveSecret({
				env: ctx.env,
				userId: user.userId,
				name: args.name,
				scope: args.scope ?? null,
				secretContext: {
					sessionId: ctx.callerContext.secretContext?.sessionId ?? null,
					appId: ctx.callerContext.secretContext?.appId ?? null,
				},
			})
		},
	},
)
