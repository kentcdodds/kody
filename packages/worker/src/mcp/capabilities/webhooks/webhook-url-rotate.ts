import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { rotateWebhookUrlForUser } from '#worker/webhooks/service.ts'
import {
	mintedWebhookUrlSchema,
	requirePackageRef,
	toMintedWebhookCapability,
	webhookPackageRefSchema,
} from './shared.ts'

export const webhookUrlRotateCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhook_url_rotate',
		description:
			'Rotate the URL secret for a minted package webhook and return the new full URL once. The replaced URL stops working immediately.',
		keywords: ['webhook', 'rotate', 'secret', 'credential', 'url'],
		readOnly: false,
		idempotent: false,
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
			webhook: mintedWebhookUrlSchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const rotated = await rotateWebhookUrlForUser({
				env: ctx.env,
				userId: user.userId,
				email: user.email,
				username: user.username,
				packageId: args.packageId,
				kodyId: args.kodyId,
				webhookName: args.webhookName,
				requestUrl: ctx.callerContext.baseUrl,
			})
			return { webhook: toMintedWebhookCapability(rotated) }
		},
	},
)
