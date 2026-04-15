import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { deleteSecret } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'

export const secretDeleteCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secret_delete',
		description:
			'Delete an existing secret reference for the signed-in user without revealing its plaintext value. Never ask the user to paste a secret, token, API key, password, or credential into chat; use generated UI to collect missing user-provided secrets safely. Use this when a secret should no longer be available to execute-time code.',
		keywords: ['secret', 'delete', 'remove', 'revoke', 'credential'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			name: z.string().min(1).describe('Secret name to delete.'),
			scope: z
				.enum(secretScopeValues)
				.describe('Scope that owns the secret being deleted.'),
		}),
		outputSchema: z.object({
			deleted: z.boolean(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return {
				deleted: await deleteSecret({
					env: ctx.env,
					userId: user.userId,
					name: args.name,
					scope: args.scope,
					storageContext: {
						sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
						appId: ctx.callerContext.storageContext?.appId ?? null,
						storageId: ctx.callerContext.storageContext?.storageId ?? null,
					},
				}),
			}
		},
	},
)
