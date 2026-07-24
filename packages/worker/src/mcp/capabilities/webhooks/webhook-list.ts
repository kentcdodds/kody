import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listWebhooksForUser } from '#worker/webhooks/service.ts'
import { listedWebhookSchema, toListedWebhookCapability } from './shared.ts'

export const webhookListCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhook_list',
		description:
			"List package.json#kody.webhooks declarations across the signed-in user's saved packages, joined with minted URL / enabled state. Declaring a webhook does not open ingress until webhook_url_mint is called. URL secrets are never returned.",
		keywords: [
			'webhook',
			'list',
			'package.json#kody.webhooks',
			'inbound',
			'manifest',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			packageId: z.string().min(1).optional(),
			kodyId: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			webhooks: z.array(listedWebhookSchema),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const webhooks = await listWebhooksForUser({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: user.userId,
				packageId: args.packageId,
				kodyId: args.kodyId,
			})
			return { webhooks: webhooks.map(toListedWebhookCapability) }
		},
	},
)
