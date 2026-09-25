import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	webhookUrlApplyGithubContentTypes,
	webhookUrlApplyHttpMethods,
	webhookUrlApplyPlaceholder,
} from '#worker/webhooks/apply.ts'
import { applyWebhookUrlForUser } from '#worker/webhooks/service.ts'
import {
	toAppliedWebhookCapability,
	webhookUrlApplyResultSchema,
} from './shared.ts'

const githubSlugSchema = z
	.string()
	.min(1)
	.regex(/^[A-Za-z0-9_.-]+$/, 'Must be a GitHub owner or repository slug.')
	.refine(
		(value) => value !== '.' && value !== '..',
		'Must be a GitHub owner or repository slug.',
	)

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

const httpDestinationSchema = z
	.object({
		type: z.literal('http'),
		url: z
			.string()
			.min(1)
			.describe(
				`HTTPS registration endpoint. May include ${webhookUrlApplyPlaceholder} for server-side URL injection.`,
			),
		method: z
			.enum(webhookUrlApplyHttpMethods)
			.optional()
			.describe('HTTP method. Defaults to POST.'),
		headers: z
			.record(z.string(), z.string())
			.optional()
			.describe(
				`Optional request headers. Values may include ${webhookUrlApplyPlaceholder}.`,
			),
		body: z
			.string()
			.max(64_384)
			.optional()
			.describe(
				`Optional request body template. May include ${webhookUrlApplyPlaceholder}.`,
			),
		integration: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional OAuth integration whose access token is sent as Authorization Bearer. Host must be allowed on the integration.',
			),
		secretName: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional host-approved secret sent as Authorization Bearer. Host must be approved for the destination URL.',
			),
	})
	.superRefine((destination, ctx) => {
		const url = destination.url.trim()
		if (!url.startsWith('https://')) {
			ctx.addIssue({
				code: 'custom',
				path: ['url'],
				message: 'Destination url must be https.',
			})
		}
		const headerValues = Object.values(destination.headers ?? {})
		const haystack = [url, ...headerValues, destination.body ?? ''].join('\n')
		if (!haystack.includes(webhookUrlApplyPlaceholder)) {
			ctx.addIssue({
				code: 'custom',
				message: `Destination must include ${webhookUrlApplyPlaceholder} in url, headers, or body.`,
			})
		}
		if (destination.secretName && destination.integration) {
			ctx.addIssue({
				code: 'custom',
				message: 'Provide either integration or secretName, not both.',
			})
		}
		const method = (destination.method ?? 'POST').toUpperCase()
		if (method === 'GET' && (destination.body?.length ?? 0) > 0) {
			ctx.addIssue({
				code: 'custom',
				path: ['body'],
				message: 'Destination body is not allowed with GET.',
			})
		}
	})

export const webhookUrlApplyDestinationSchema = z.discriminatedUnion('type', [
	githubDestinationSchema,
	httpDestinationSchema,
])

export const webhookUrlApplyCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookUrlApply',
		description:
			'Register a minted webhook URL at a destination without exposing the credential. Pass the handle from webhookUrlMint, webhookUrlRotate, or webhookList. Destination type github creates the repo hook via the user GitHub integration (or a host-approved GitHub token). Destination type http performs an outbound HTTPS request and substitutes {{webhookUrl}} server-side into url/headers/body. Returns ok, remote_id, and url_host only — never the credential URL.',
		keywords: [
			'webhook',
			'apply',
			'register',
			'github',
			'http',
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
			destination: webhookUrlApplyDestinationSchema,
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
