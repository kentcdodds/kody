import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { mintWebhookUrlForUser } from '#worker/webhooks/service.ts'
import {
	mintedWebhookUrlSchema,
	requirePackageRef,
	toMintedWebhookCapability,
	webhookPackageRefSchema,
} from './shared.ts'

export const webhookUrlMintCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhook_url_mint',
		description:
			'Mint (or remint) the URL secret for a package-declared webhook and return the full ingress URL once. Treat the URL as a credential — it cannot be retrieved later (use webhook_url_rotate). Declaring kody.webhooks alone does not open ingress; minting does.',
		keywords: ['webhook', 'mint', 'url', 'activate', 'credential', 'inbound'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z
			.object({
				...webhookPackageRefSchema,
				webhookName: z
					.string()
					.min(1)
					.describe('Webhook name from package.json#kody.webhooks[].name.'),
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
			const minted = await mintWebhookUrlForUser({
				env: ctx.env,
				userId: user.userId,
				email: user.email,
				username: user.username,
				packageId: args.packageId,
				kodyId: args.kodyId,
				webhookName: args.webhookName,
				requestUrl: ctx.callerContext.baseUrl,
			})
			return { webhook: toMintedWebhookCapability(minted) }
		},
	},
)
