import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { buildSecretUsageUrl } from '#mcp/secrets/package-approval-url.ts'
import { lockSecretToPackage } from '#mcp/secrets/service.ts'

const outputSchema = z.object({
	name: z.string(),
	scope: z.literal('user'),
	allowed_packages: z.array(z.string()),
	usage_url: z.string(),
})

export const secretLockCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secret_lock',
		description:
			'Grant a user-scoped secret to a saved package by adding that package id to allowed_packages. Additional grants accumulate. Agents can grant; removing a grant is website-only at /account/secrets/user/:name. This capability cannot remove packages. User secrets still allow execute and self-authored / adopted packages to read unless the owner tightens further on the account page. secret_set cannot change allowed_packages.',
		keywords: [
			'secret',
			'lock',
			'package',
			'usage',
			'restrict',
			'grant',
			'allowed_packages',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			name: z.string().min(1).describe('User-scoped secret name to grant.'),
			package_id: z
				.string()
				.min(1)
				.describe('Saved package id that may use this secret.'),
		}),
		outputSchema,
		async handler(
			args: { name: string; package_id: string },
			ctx: CapabilityContext,
		) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				const updated = await lockSecretToPackage({
					env: ctx.env,
					userId: user.userId,
					name: args.name,
					packageId: args.package_id,
				})
				return {
					name: updated.name,
					scope: 'user' as const,
					allowed_packages: updated.allowedPackages,
					usage_url: buildSecretUsageUrl({
						baseUrl: ctx.callerContext.baseUrl,
						name: updated.name,
					}),
				}
			} catch (error) {
				throw new McpCallerError(
					error instanceof Error
						? error.message
						: 'Unable to lock this secret to a package.',
					{ cause: error },
				)
			}
		},
	},
)
