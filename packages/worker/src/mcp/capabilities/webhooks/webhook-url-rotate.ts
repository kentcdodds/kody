import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { rotateWebhookUrlForUser } from '#worker/webhooks/service.ts'
import {
	mintedWebhookHandleSchema,
	requirePackageRef,
	toMintedWebhookCapability,
	webhookPackageRefSchema,
} from './shared.ts'

export const webhookUrlRotateCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookUrlRotate',
		description:
			'Rotate the URL secret for a minted package webhook and return a new opaque handle. The previous URL stays active for 24 hours, or until a delivery arrives on the new URL. Register the new URL with webhookUrlApply — the credential is never returned.',
		keywords: ['webhook', 'rotate', 'secret', 'handle', 'url'],
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
			webhook: mintedWebhookHandleSchema,
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
