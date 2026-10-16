import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { setWebhookEnabledForUser } from '#worker/webhooks/service.ts'
import { requirePackageRef, webhookPackageRefSchema } from './shared.ts'

export const webhookEnableCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookEnable',
		orgPermission: 'package:write',
		description:
			'Enable a disabled package webhook so ingress accepts deliveries again.',
		keywords: ['webhook', 'enable', 'activate'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z
			.object({
				...webhookPackageRefSchema,
				webhookName: z.string().min(1),
				endpointId: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Minted endpoint to enable. Required when several URLs share the webhook name.',
					),
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
			endpoint_id: z.string(),
			enabled: z.literal(true),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const updated = await setWebhookEnabledForUser({
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
				userId: ownerIdFromCaller(ctx.callerContext),
				packageId: args.packageId,
				kodyId: args.kodyId,
				webhookName: args.webhookName,
				endpointId: args.endpointId,
				enabled: true,
			})
			return {
				package_id: updated.packageId,
				webhook_name: updated.webhookName,
				endpoint_id: updated.id,
				enabled: true as const,
			}
		},
	},
)
