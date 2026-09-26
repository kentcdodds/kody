import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	httpDestinationIncludesWebhookUrlPlaceholder,
	webhookUrlApplyGithubContentTypes,
	webhookUrlApplyHttpMethods,
	webhookUrlApplyPlaceholder,
	type WebhookUrlApplyDestination,
} from '#worker/webhooks/apply.ts'
import { applyWebhookUrlForUser } from '#worker/webhooks/service.ts'
import { requireWebhookApplyDestinationGrantOrPending } from '#worker/webhooks/apply-destination-approval.ts'
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
		if (
			!httpDestinationIncludesWebhookUrlPlaceholder({
				url,
				headers: destination.headers,
				body: destination.body,
			})
		) {
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

type HttpApplyDestinationInput = z.infer<typeof httpDestinationSchema>

const httpApplyInteractiveOnlyErrorMessage =
	'webhookUrlApply destination type "http" is only available from an interactive MCP agent flow after the owner explicitly approves the exact outbound destination. Package jobs, subscriptions, webhooks, and other package runtimes cannot register arbitrary apply destinations.'

function assertInteractiveHttpApplyCaller(callerContext: {
	executionOrigin?: string
	storageContext?: {
		packageId?: string | null
		appId?: string | null
		storageId?: string | null
	} | null
}) {
	if (callerContext.executionOrigin !== 'interactive') {
		throw new McpCallerError(httpApplyInteractiveOnlyErrorMessage)
	}
	const storageContext = callerContext.storageContext
	const packageId = storageContext?.packageId?.trim() ?? ''
	const appId = storageContext?.appId?.trim() ?? ''
	const storageId = storageContext?.storageId?.trim() ?? ''
	if (packageId || appId || storageId) {
		throw new McpCallerError(httpApplyInteractiveOnlyErrorMessage)
	}
}

async function assertHttpApplyDestinationApproved(input: {
	env: Env
	userId: string
	handle: string
	destination: HttpApplyDestinationInput
	baseUrl: string
}) {
	try {
		const gate = await requireWebhookApplyDestinationGrantOrPending({
			db: input.env.APP_DB,
			userId: input.userId,
			handle: input.handle,
			destination: input.destination,
			baseUrl: input.baseUrl,
		})
		if (gate.status === 'granted') return
		throw new McpCallerError(gate.message)
	} catch (error) {
		if (error instanceof McpCallerError) throw error
		throw new McpCallerError(
			error instanceof Error
				? error.message
				: 'Unable to check webhook apply approval.',
			{ cause: error },
		)
	}
}

function toApplyDestination(
	destination: z.infer<typeof webhookUrlApplyDestinationSchema>,
): WebhookUrlApplyDestination {
	return destination
}

export const webhookUrlApplyCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookUrlApply',
		description:
			'Register a minted webhook URL at a destination without exposing the credential. Pass the handle from webhookUrlMint, webhookUrlRotate, or webhookList. Destination type github creates the repo hook via the user GitHub integration (or a host-approved GitHub token). Destination type http performs an outbound HTTPS request and substitutes {{webhookUrl}} server-side into url/headers/body — interactive MCP only, and only after the owner Approves the exact destination via the same account approval flow as /connect/secrets host approval (approval_url → website Allow → durable grant → retry). Returns ok, remote_id, and url_host only — never the credential URL.',
		keywords: [
			'webhook',
			'apply',
			'register',
			'github',
			'http',
			'handle',
			'destination',
			'approval',
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
			if (args.destination.type === 'http') {
				assertInteractiveHttpApplyCaller(ctx.callerContext)
				await assertHttpApplyDestinationApproved({
					env: ctx.env,
					userId: user.userId,
					handle: args.handle,
					destination: args.destination,
					baseUrl: ctx.callerContext.baseUrl,
				})
			}
			const applied = await applyWebhookUrlForUser({
				env: ctx.env,
				userId: user.userId,
				email: user.email,
				username: user.username,
				handle: args.handle,
				destination: toApplyDestination(args.destination),
				requestUrl: ctx.callerContext.baseUrl,
				waitUntil: ctx.waitUntil,
			})
			return toAppliedWebhookCapability(applied)
		},
	},
)
