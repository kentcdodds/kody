import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	webhookUrlApplyGithubContentTypes,
	webhookUrlApplyHttpMethods,
	webhookUrlApplyPlaceholder,
	type WebhookUrlApplyDestination,
	type WebhookUrlApplyHttpDestination,
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
		user_confirmed: z
			.literal(true)
			.optional()
			.describe(
				`Required for type "http". Set true only after showing the owner the exact method, destination URL, ${webhookUrlApplyPlaceholder} injection sites, headers, body template, and auth mode, and receiving explicit approval for that outbound registration. Owner settings paste is consent; silent model-chosen apply is not.`,
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

function listWebhookUrlInjectionSites(destination: HttpApplyDestinationInput) {
	const sites: Array<string> = []
	if (destination.url.includes(webhookUrlApplyPlaceholder)) sites.push('url')
	for (const [name, value] of Object.entries(destination.headers ?? {})) {
		if (value.includes(webhookUrlApplyPlaceholder)) {
			sites.push(`header:${name}`)
		}
	}
	if ((destination.body ?? '').includes(webhookUrlApplyPlaceholder)) {
		sites.push('body')
	}
	return sites
}

function describeHttpApplyAuth(destination: HttpApplyDestinationInput) {
	const secretName = destination.secretName?.trim()
	if (secretName) return `secretName=${secretName}`
	const integration = destination.integration?.trim()
	if (integration) return `integration=${integration}`
	const authorizationHeader = Object.entries(destination.headers ?? {}).find(
		([name]) => name.toLowerCase() === 'authorization',
	)
	if (authorizationHeader) {
		return `header:${authorizationHeader[0]} (caller-supplied)`
	}
	return 'none'
}

export function buildHttpApplyConfirmationMessage(
	destination: HttpApplyDestinationInput,
) {
	const method = (destination.method ?? 'POST').toUpperCase()
	const url = destination.url.trim()
	const injectionSites = listWebhookUrlInjectionSites(destination)
	const headerLines = Object.entries(destination.headers ?? {}).map(
		([name, value]) => `${name}=${value}`,
	)
	const body = destination.body ?? ''
	return [
		'HTTP webhookUrlApply requires explicit owner approval for this outbound registration (prompt-injection / confused-deputy protection). Show the owner this exact destination, wait for explicit approval, then retry with destination.user_confirmed: true.',
		'',
		`method: ${method}`,
		`url: ${url}`,
		`${webhookUrlApplyPlaceholder} injection sites: ${injectionSites.join(', ') || '(none)'}`,
		`headers: ${headerLines.length > 0 ? headerLines.join('; ') : '(none)'}`,
		`body: ${body.length > 0 ? body : '(none)'}`,
		`auth: ${describeHttpApplyAuth(destination)}`,
	].join('\n')
}

function assertHttpApplyUserConfirmed(destination: HttpApplyDestinationInput) {
	if (destination.user_confirmed === true) return
	throw new McpCallerError(buildHttpApplyConfirmationMessage(destination))
}

function toApplyDestination(
	destination: z.infer<typeof webhookUrlApplyDestinationSchema>,
): WebhookUrlApplyDestination {
	if (destination.type === 'github') return destination
	const { user_confirmed: _userConfirmed, ...httpDestination } = destination
	return httpDestination satisfies WebhookUrlApplyHttpDestination
}

export const webhookUrlApplyCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookUrlApply',
		description:
			'Register a minted webhook URL at a destination without exposing the credential. Pass the handle from webhookUrlMint, webhookUrlRotate, or webhookList. Destination type github creates the repo hook via the user GitHub integration (or a host-approved GitHub token). Destination type http performs an outbound HTTPS request and substitutes {{webhookUrl}} server-side into url/headers/body — interactive MCP only, and only after showing the owner the exact destination and setting user_confirmed: true. Returns ok, remote_id, and url_host only — never the credential URL.',
		keywords: [
			'webhook',
			'apply',
			'register',
			'github',
			'http',
			'handle',
			'destination',
			'confirm',
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
				assertHttpApplyUserConfirmed(args.destination)
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
