import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	webhookUrlApplyGithubContentTypes,
	webhookUrlApplyHttpsMethods,
} from '#worker/webhooks/apply.ts'
import { applyWebhookUrlForUser } from '#worker/webhooks/service.ts'
import { webhookUrlPlaceholder } from '#worker/webhooks/redact.ts'
import {
	toAppliedWebhookCapability,
	webhookUrlApplyResultSchema,
} from './shared.ts'

const githubSlugSchema = z
	.string()
	.min(1)
	.regex(/^[A-Za-z0-9_.-]+$/, 'Must be a GitHub owner or repository slug.')

const httpsDestinationSchema = z.object({
	type: z.literal('https'),
	url: z
		.string()
		.url()
		.describe(
			`Destination URL. Include ${webhookUrlPlaceholder} here or in headers/body.`,
		),
	method: z.enum(webhookUrlApplyHttpsMethods).optional(),
	headers: z.record(z.string(), z.string()).optional(),
	body: z
		.string()
		.optional()
		.describe(`Request body. Substitute ${webhookUrlPlaceholder} server-side.`),
	integration: z
		.string()
		.min(1)
		.optional()
		.describe(
			'OAuth integration name for Authorization. Mutually exclusive with secretName.',
		),
	secretName: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Host-approved secret used as a Bearer token. Mutually exclusive with integration.',
		),
})

const githubDestinationSchema = z.object({
	type: z.literal('github'),
	owner: githubSlugSchema,
	repo: githubSlugSchema,
	events: z.array(z.string().min(1)).optional(),
	contentType: z.enum(webhookUrlApplyGithubContentTypes).optional(),
	active: z.boolean().optional(),
	integration: z
		.string()
		.min(1)
		.optional()
		.describe(
			'OAuth integration name. Defaults to "github" when secretName is omitted.',
		),
	secretName: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Host-approved GitHub token secret. Use instead of an OAuth integration.',
		),
	hookSecretName: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional HMAC secret name to set as the GitHub hook secret. Defaults to the package webhook verification.secretName when present.',
		),
})

export const webhookUrlApplyCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookUrlApply',
		description:
			'Register a minted webhook URL at a destination without exposing the credential. Pass the handle from webhookUrlMint, webhookUrlRotate, or webhookList. Use type github for GitHub repo hooks, or type https with {{webhookUrl}} substituted server-side via a user integration or host-approved secret. Returns ok, remote_id, and url_host only.',
		keywords: [
			'webhook',
			'apply',
			'register',
			'github',
			'stripe',
			'handle',
			'destination',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			handle: z
				.string()
				.min(1)
				.describe(
					'Opaque handle from webhookUrlMint, webhookUrlRotate, or webhookList.',
				),
			destination: z.discriminatedUnion('type', [
				httpsDestinationSchema,
				githubDestinationSchema,
			]),
		}),
		outputSchema: webhookUrlApplyResultSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const applied = await applyWebhookUrlForUser({
				env: ctx.env,
				userId: user.userId,
				email: user.email,
				username: user.username,
				handle: args.handle,
				destination: args.destination,
				requestUrl: ctx.callerContext.baseUrl,
				waitUntil: ctx.waitUntil,
			})
			return toAppliedWebhookCapability(applied)
		},
	},
)
