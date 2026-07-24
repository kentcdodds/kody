import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { updateWebhookEndpointForUser } from '#worker/webhooks/service.ts'
import {
	toCapabilityEndpoint,
	webhookEndpointSchema,
	webhookVerificationInputSchema,
} from './shared.ts'

const inputSchema = z
	.object({
		id: z.string().min(1).describe('Webhook endpoint id to update.'),
		name: z.string().min(1).optional().describe('New unique name.'),
		packageId: z
			.string()
			.min(1)
			.optional()
			.describe('Rebind to this saved package id.'),
		kodyId: z
			.string()
			.min(1)
			.optional()
			.describe('Rebind to this saved package kody id.'),
		exportName: z
			.string()
			.min(1)
			.optional()
			.describe('Rebind to this package export name.'),
		responseMode: z.enum(['ack', 'sync']).optional(),
		enabled: z
			.boolean()
			.optional()
			.describe('Enable or disable the endpoint without deleting it.'),
		verification: webhookVerificationInputSchema
			.optional()
			.describe(
				'Replace HMAC verification config. Secret is encrypted at rest.',
			),
		clearVerification: z
			.boolean()
			.optional()
			.describe('When true, remove signature verification from the endpoint.'),
	})
	.refine(
		(input) =>
			input.name !== undefined ||
			input.packageId !== undefined ||
			input.kodyId !== undefined ||
			input.exportName !== undefined ||
			input.responseMode !== undefined ||
			input.enabled !== undefined ||
			input.verification !== undefined ||
			input.clearVerification === true,
		{ message: 'Provide at least one field to update.' },
	)
	.refine(
		(input) => !(input.verification !== undefined && input.clearVerification),
		{
			message: 'Provide verification or clearVerification, not both.',
			path: ['clearVerification'],
		},
	)

export const webhookEndpointUpdateCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhook_endpoint_update',
		description:
			'Update an inbound webhook endpoint: rename, enable/disable, rebind the package export, or set/clear HMAC verification. Does not rotate the URL secret.',
		keywords: [
			'webhook',
			'endpoint',
			'update',
			'enable',
			'disable',
			'verification',
			'rebind',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema: z.object({
			endpoint: webhookEndpointSchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const endpoint = await updateWebhookEndpointForUser({
				env: ctx.env,
				userId: user.userId,
				endpointId: args.id,
				name: args.name,
				packageId: args.packageId,
				kodyId: args.kodyId,
				exportName: args.exportName,
				responseMode: args.responseMode,
				enabled: args.enabled,
				verification: args.verification,
				clearVerification: args.clearVerification,
			})
			if (!endpoint) {
				throw new Error('Webhook endpoint not found.')
			}
			return { endpoint: toCapabilityEndpoint(endpoint) }
		},
	},
)
