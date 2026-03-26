import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { updateSecret } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import { secretMetadataSchema } from './shared.ts'

export const secretUpdateCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secret_update',
		description:
			'Update an existing secret value or description for the signed-in user. Use this when rotating a secret or correcting its non-sensitive metadata.',
		keywords: ['secret', 'update', 'rotate', 'credential'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z
			.object({
				name: z.string().min(1).describe('Secret name to update.'),
				scope: z
					.enum(secretScopeValues)
					.describe('Scope that owns the secret being updated.'),
				value: z
					.string()
					.min(1)
					.optional()
					.describe('Optional replacement value for the secret.'),
				description: z
					.string()
					.optional()
					.describe(
						'Optional replacement description for the secret metadata.',
					),
			})
			.refine(
				(value) => value.value !== undefined || value.description !== undefined,
				{
					message: 'Provide `value`, `description`, or both.',
					path: ['value'],
				},
			),
		outputSchema: z.object({
			secret: secretMetadataSchema,
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const secret = await updateSecret({
				env: ctx.env,
				userId: user.userId,
				name: args.name,
				scope: args.scope,
				value: args.value,
				description: args.description,
				secretContext: {
					sessionId: ctx.callerContext.secretContext?.sessionId ?? null,
					appId: ctx.callerContext.secretContext?.appId ?? null,
				},
			})
			return {
				secret: {
					name: secret.name,
					scope: secret.scope,
					description: secret.description,
					app_id: secret.appId,
					created_at: secret.createdAt,
					updated_at: secret.updatedAt,
					ttl_ms: secret.ttlMs,
				},
			}
		},
	},
)
