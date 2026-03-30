import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listSecrets } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import { secretMetadataSchema } from './shared.ts'

export const secretListCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secret_list',
		description:
			'List available secret references for the signed-in user without revealing secret values. When scope is omitted, results include every accessible scope in precedence order. Use `codemode.secret_list({ scope })` inside execute-time code when you want the same metadata, including allowed hosts and allowed capabilities, from the sandbox. Never return a secret value from execute, and never ask the user to paste a secret, token, API key, password, or credential into chat; use generated UI to collect missing secrets safely.',
		keywords: ['secret', 'list', 'discovery', 'metadata', 'credentials'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			scope: z
				.enum(secretScopeValues)
				.optional()
				.describe(
					'Optional scope filter. When omitted, list all accessible scopes in default precedence order.',
				),
		}),
		outputSchema: z.object({
			secrets: z.array(secretMetadataSchema),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const secrets = await listSecrets({
				env: ctx.env,
				userId: user.userId,
				scope: args.scope ?? null,
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
				},
			})
			return {
				secrets: secrets.map((secret) => ({
					name: secret.name,
					scope: secret.scope,
					description: secret.description,
					app_id: secret.appId,
					allowed_hosts: secret.allowedHosts,
					allowed_capabilities: secret.allowedCapabilities,
					created_at: secret.createdAt,
					updated_at: secret.updatedAt,
					ttl_ms: secret.ttlMs,
				})),
			}
		},
	},
)
