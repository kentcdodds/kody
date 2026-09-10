import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listWebhooksForUser } from '#worker/webhooks/service.ts'
import {
	applyWebhookPackageRefAliases,
	listedWebhookSchema,
	readWebhookPackageName,
	toListedWebhookCapability,
} from './shared.ts'

export const webhookListCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookList',
		description:
			"List package.json#kody.webhooks declarations across the signed-in user's saved packages, joined with minted handle / enabled state. Declaring a webhook does not open ingress until webhookUrlMint is called. URL secrets and credential URLs are never returned.",
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
		inputSchema: z.preprocess(
			applyWebhookPackageRefAliases,
			z.object({
				packageId: z.string().min(1).optional(),
				packageName: z.string().min(1).optional(),
			}),
		),
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
				kodyId: readWebhookPackageName(args),
			})
			return { webhooks: webhooks.map(toListedWebhookCapability) }
		},
	},
)
