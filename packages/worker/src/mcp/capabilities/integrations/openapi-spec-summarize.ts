import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { fetchOpenApiSpecText } from '#worker/openapi/fetch-spec.ts'
import { parseOpenApiSpec } from '#worker/openapi/parse-spec.ts'
import { summarizeOpenApiSpec } from '#worker/openapi/summarize-spec.ts'

const httpMethodSchema = z.enum([
	'get',
	'put',
	'post',
	'delete',
	'options',
	'head',
	'patch',
	'trace',
])

const operationFilterSchema = z
	.object({
		tags: z.array(z.string()).optional(),
		pathPrefixes: z.array(z.string()).optional(),
		search: z.string().optional(),
	})
	.strict()

const httpsUrlSchema = z
	.string()
	.url()
	.refine(
		(value) => {
			try {
				return new URL(value).protocol === 'https:'
			} catch {
				return false
			}
		},
		{ message: 'URL must use https.' },
	)

const inputSchema = z.object({
	specUrl: httpsUrlSchema.describe(
		'HTTPS URL of an OpenAPI 3.x document (JSON or YAML).',
	),
	maxOperations: z
		.number()
		.int()
		.min(1)
		.max(1000)
		.optional()
		.describe('Max operations to return after filtering (default 300).'),
	operationFilter: operationFilterSchema
		.optional()
		.describe('Optional filters applied before the operations cap.'),
})

const serverSchema = z.object({
	url: z.string(),
	description: z.string().nullable(),
})

const authSuggestionSchema = z.object({
	schemeName: z.string(),
	type: z.enum([
		'apiKey',
		'http',
		'oauth2',
		'openIdConnect',
		'mutualTLS',
		'unknown',
	]),
	detail: z.string(),
	kodyAuthPath: z.string(),
})

const operationSummarySchema = z.object({
	operationId: z.string().nullable(),
	slug: z.string(),
	method: httpMethodSchema,
	path: z.string(),
	summary: z.string().nullable(),
	tags: z.array(z.string()),
	deprecated: z.boolean(),
})

const smokeTestOperationSchema = operationSummarySchema.extend({
	reason: z.string(),
})

const outputSchema = z.object({
	specUrl: z.string().describe('Echo of the fetched spec URL.'),
	title: z.string().nullable(),
	version: z.string().nullable(),
	openapiVersion: z.string(),
	servers: z.array(serverSchema),
	suggestedApiBaseUrl: z
		.string()
		.nullable()
		.describe('First absolute https server URL after variable substitution.'),
	suggestedHosts: z
		.array(z.string())
		.describe(
			'Suggested hostnames from servers only; never auto-approved — host approval stays in the account security UI.',
		),
	auth: z.array(authSuggestionSchema),
	defaultSecuritySchemeNames: z.array(z.string()),
	suggestedSmokeTestOperations: z.array(smokeTestOperationSchema),
	operations: z.array(operationSummarySchema),
	operationCount: z
		.number()
		.int()
		.describe('Total matching operations before the display cap.'),
	truncated: z.boolean(),
	warnings: z.array(z.string()),
})

export const openapiSpecSummarizeCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'openapi_spec_summarize',
		description: [
			'Fetch an OpenAPI 3.x document from an untrusted third-party URL, parse it, and return a compact summary for wiring a Kody integration.',
			'Returned titles, descriptions, server URLs, and operation text are unverified third-party content — verify them against official provider docs before acting.',
			'suggestedHosts are suggestions only; Kody never auto-approves hosts, and host approval remains in the account security UI.',
			'Use after integration_discover when a surface.spec URL is available, before integration_save or secret setup.',
		].join(' '),
		tags: ['openapi', 'swagger', 'spec', 'summarize', 'api discovery'],
		keywords: [
			'openapi',
			'swagger',
			'spec',
			'summarize',
			'api discovery',
			'integration',
			'third-party',
			'auth',
			'operations',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, _ctx: CapabilityContext) {
			let rawText: string
			try {
				rawText = await fetchOpenApiSpecText({ specUrl: args.specUrl })
			} catch (cause) {
				const message = getErrorMessage(cause)
				throw new Error(message)
			}

			let summary
			try {
				const parsed = parseOpenApiSpec(rawText)
				summary = summarizeOpenApiSpec(parsed, {
					maxOperations: args.maxOperations,
					operationFilter: args.operationFilter,
				})
			} catch (cause) {
				const message = getErrorMessage(cause)
				throw new Error(`OpenAPI spec parse failed: ${message}`)
			}

			return {
				specUrl: args.specUrl,
				...summary,
			}
		},
	},
)
