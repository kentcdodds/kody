import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { setWebhookEnabledForUser } from '#worker/webhooks/service.ts'
import { requirePackageRef, webhookPackageRefSchema } from './shared.ts'

export const webhookDisableCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhook_disable',
		description:
			'Disable a minted package webhook. Ingress returns 404 while disabled (indistinguishable from unknown/unminted).',
		keywords: ['webhook', 'disable', 'deactivate'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z
			.object({
				...webhookPackageRefSchema,
				webhookName: z.string().min(1),
			})
			.superRefine((input, ctx) => {
				try {
					requirePackageRef(input)
				} catch (error) {
					ctx.addIssue({
						code: 'custom',
						path: ['packageId'],
						message:
							error instanceof Error ? error.message : 'Invalid package ref.',
					})
				}
			}),
		outputSchema: z.object({
			package_id: z.string(),
			webhook_name: z.string(),
			enabled: z.literal(false),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const updated = await setWebhookEnabledForUser({
				env: ctx.env,
				userId: user.userId,
				packageId: args.packageId,
				kodyId: args.kodyId,
				webhookName: args.webhookName,
				enabled: false,
			})
			return {
				package_id: updated.packageId,
				webhook_name: updated.webhookName,
				enabled: false as const,
			}
		},
	},
)
