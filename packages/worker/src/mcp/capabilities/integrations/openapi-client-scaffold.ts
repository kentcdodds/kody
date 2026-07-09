import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { openApiBoundAuthSchema } from '#worker/openapi/auth-binding.ts'
import { fetchOpenApiSpecText } from '#worker/openapi/fetch-spec.ts'
import { parseOpenApiSpec } from '#worker/openapi/parse-spec.ts'
import { scaffoldOpenApiClient } from '#worker/openapi/scaffold-client.ts'

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

const httpsUrlSchema = z
	.string()
	.url()
	.refine((value) => {
		try {
			return new URL(value).protocol === 'https:'
		} catch {
			return false
		}
	}, 'Must be an https URL.')

const inputSchema = z.object({
	specUrl: httpsUrlSchema.describe(
		'HTTPS URL of an OpenAPI 3.x document (JSON or YAML).',
	),
	operationIds: z
		.array(z.string().min(1))
		.min(1)
		.max(50)
		.describe(
			'Operation slugs from openapi_spec_summarize output (stable snake_case ids).',
		),
	auth: openApiBoundAuthSchema.describe(
		'How the scaffolded client authenticates. References secret or integration names only — never credential values.',
	),
	apiBaseUrl: httpsUrlSchema.describe(
		'Absolute https API base URL used by the generated client.',
	),
	providerLabel: z
		.string()
		.min(1)
		.optional()
		.describe('Optional label included only in generated source comments.'),
})

const scaffoldedOperationSchema = z.object({
	slug: z.string(),
	exportName: z.string(),
	method: httpMethodSchema,
	path: z.string(),
})

const outputSchema = z.object({
	moduleSource: z
		.string()
		.describe('Complete dependency-free ESM module source for the client.'),
	operations: z.array(scaffoldedOperationSchema),
	warnings: z.array(z.string()),
	usageNotes: z
		.string()
		.describe('Short guidance for pasting and running the generated module.'),
})

function buildUsageNotes(authKind: string): string {
	const integrationNote =
		authKind === 'integration'
			? ' For integration auth, complete the connect flow for that provider first.'
			: ''
	return [
		'Paste moduleSource into execute as an ephemeral module, or into a package client.ts.',
		'Hosts and secrets still require approval in the account security UI; the OpenAPI spec never widens host approval.',
		`Auth kind for this scaffold: ${authKind}.${integrationNote}`,
	].join(' ')
}

export const openapiClientScaffoldCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'openapi_client_scaffold',
		description: [
			'Fetch an untrusted third-party OpenAPI 3.x document and scaffold a small dependency-free ESM client for selected operations.',
			'Generated code references secret NAMES only via Kody fetch-gateway placeholders (never secret values), and host approval is never widened by the spec.',
			'Use after openapi_spec_summarize to turn chosen operation slugs into callable client functions for execute or a package.',
		].join(' '),
		tags: ['openapi', 'scaffold', 'client', 'codegen', 'api'],
		keywords: [
			'openapi',
			'scaffold',
			'client',
			'codegen',
			'api',
			'swagger',
			'generate',
			'integration',
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

			let scaffold
			try {
				const parsed = parseOpenApiSpec(rawText)
				scaffold = scaffoldOpenApiClient({
					spec: parsed,
					operationSlugs: args.operationIds,
					auth: args.auth,
					apiBaseUrl: args.apiBaseUrl,
					providerLabel: args.providerLabel,
				})
			} catch (cause) {
				const message = getErrorMessage(cause)
				if (message.startsWith('No resolvable operations')) {
					throw new Error(message)
				}
				throw new Error(`OpenAPI client scaffold failed: ${message}`)
			}

			return {
				moduleSource: scaffold.moduleSource,
				operations: scaffold.operations,
				warnings: scaffold.warnings,
				usageNotes: buildUsageNotes(args.auth.kind),
			}
		},
	},
)
