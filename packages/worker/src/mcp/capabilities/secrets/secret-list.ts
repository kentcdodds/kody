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
			'List available secret references for the signed-in user. Results include metadata such as names, descriptions, allowed hosts, and allowed kody. Use `kody.secret_list({ scope })` inside execute-time code when you want the same metadata from the sandbox. To use a listed secret in an outbound `fetch`, reference it by placeholder — e.g. `Authorization: "Bearer {{secret:name}}"` (optionally `{{secret:name|scope=user}}`) — and Kody resolves it for approved hosts; plaintext values are never returned. Use `/account/secrets/new` for user-provided API key, token, and credential entry or rotation.',
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
			const packageId =
				ctx.callerContext.storageContext?.packageId?.trim() || null
			const secrets = await listSecrets({
				env: ctx.env,
				userId: user.userId,
				scope: args.scope ?? null,
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
					packageId: ctx.callerContext.storageContext?.packageId ?? null,
					storageId: ctx.callerContext.storageContext?.storageId ?? null,
				},
			})
			const accessibleSecrets = packageId
				? secrets.filter(
						(secret) =>
							secret.scope !== 'user' ||
							secret.allowedPackages.includes(packageId),
					)
				: secrets
			return {
				secrets: accessibleSecrets.map((secret) => ({
					name: secret.name,
					scope: secret.scope,
					description: secret.description,
					package_id: secret.packageId,
					allowed_hosts: secret.allowedHosts,
					allowed_capabilities: secret.allowedCapabilities,
					allowed_packages: secret.allowedPackages,
					created_at: secret.createdAt,
					updated_at: secret.updatedAt,
					ttl_ms: secret.ttlMs,
				})),
			}
		},
	},
)
