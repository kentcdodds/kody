import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { createWebhookEndpointForUser } from '#worker/webhooks/service.ts'
import {
	toCapabilityEndpointWithSecret,
	webhookEndpointWithSecretSchema,
	webhookVerificationInputSchema,
} from './shared.ts'

const inputSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.describe(
				'Human-readable name unique per user (for example sentry-errors).',
			),
		packageId: z
			.string()
			.min(1)
			.optional()
			.describe('Saved package id to bind. Provide packageId or kodyId.'),
		kodyId: z
			.string()
			.min(1)
			.optional()
			.describe('Saved package kody id to bind. Provide packageId or kodyId.'),
		exportName: z
			.string()
			.min(1)
			.describe(
				'Package export to invoke for each delivery (for example handle-webhook).',
			),
		responseMode: z
			.enum(['ack', 'sync'])
			.optional()
			.describe(
				'ack (default) returns 202 immediately and runs the export in the background; sync waits for the export JSON result.',
			),
		verification: webhookVerificationInputSchema
			.optional()
			.describe(
				'Optional HMAC signature verification. Secret is encrypted at rest and never returned later.',
			),
	})
	.refine(
		(input) => input.packageId !== undefined || input.kodyId !== undefined,
		{ message: 'Provide packageId or kodyId.', path: ['packageId'] },
	)

export const webhookEndpointCreateCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhook_endpoint_create',
		description:
			'Create a user-owned inbound webhook endpoint bound to a saved-package export. Returns the full endpoint URL with a one-time URL secret — treat it as a credential and store it immediately; it cannot be retrieved later (use webhook_endpoint_rotate_secret to issue a new URL).',
		keywords: [
			'webhook',
			'inbound',
			'endpoint',
			'create',
			'sentry',
			'github',
			'stripe',
			'http callback',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema: z.object({
			endpoint: webhookEndpointWithSecretSchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const created = await createWebhookEndpointForUser({
				env: ctx.env,
				userId: user.userId,
				email: user.email,
				username: user.username,
				name: args.name,
				packageId: args.packageId,
				kodyId: args.kodyId,
				exportName: args.exportName,
				responseMode: args.responseMode,
				verification: args.verification,
				requestUrl: ctx.callerContext.baseUrl,
			})
			return { endpoint: toCapabilityEndpointWithSecret(created) }
		},
	},
)
