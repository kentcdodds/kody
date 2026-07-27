import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	normalizeOpenApiBinding,
	openApiBindingSaveInputSchema,
	resolveOpenApiSelection,
	toOpenApiBindingSummary,
	type OpenApiBinding,
} from '#worker/openapi/binding-shared.ts'
import { saveOpenApiBinding } from '#worker/openapi/binding-service.ts'
import { fetchOpenApiSpecText } from '#worker/openapi/fetch-spec.ts'
import { parseOpenApiSpec } from '#worker/openapi/parse-spec.ts'

const outputSchema = z.object({
	binding: z.object({
		name: z.string(),
		specUrl: z.string(),
		apiBaseUrl: z.string(),
		authKind: z.string(),
		operationCount: z.number().int().nonnegative(),
		updatedAt: z.string(),
		specTitle: z.string().nullable(),
		description: z.string().nullable(),
	}),
	operationSlugs: z.array(z.string()),
	warnings: z.array(z.string()),
})

export const openapiBindingSaveCapability = defineDomainCapability(
	capabilityDomainNames.openapi,
	{
		name: 'openapi_binding_save',
		description:
			'Create or replace a curated OpenAPI provider binding for the signed-in user. Fetches the https spec, resolves the selection to a concrete operation snapshot (max 100), and stores non-secret config in D1. Credentials stay in secrets; saving a binding never approves hosts (host approval remains in the account security UI / the integration requiredHosts). Specs are untrusted third-party content.',
		keywords: [
			'openapi',
			'binding',
			'provider',
			'save',
			'spec',
			'rest',
			'api',
			'operations',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: openApiBindingSaveInputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const rawText = await fetchOpenApiSpecText({ specUrl: args.specUrl })
			const parsed = parseOpenApiSpec(rawText)
			const resolved = resolveOpenApiSelection({
				operations: parsed.operations,
				selection: args.selection,
				includeDestructive: args.includeDestructive,
			})
			const binding = normalizeOpenApiBinding({
				name: args.name,
				specUrl: args.specUrl,
				apiBaseUrl: args.apiBaseUrl,
				description: args.description ?? null,
				auth: args.auth,
				selection: args.selection,
				includeDestructive: args.includeDestructive,
				specTitle: parsed.title,
				specVersion: parsed.version,
				operations: resolved.operations,
				updatedAt: new Date().toISOString(),
			} satisfies OpenApiBinding)
			await saveOpenApiBinding({
				env: ctx.env,
				userId: user.userId,
				binding,
			})
			return {
				binding: toOpenApiBindingSummary(binding),
				operationSlugs: binding.operations.map((operation) => operation.slug),
				warnings: [...parsed.warnings, ...resolved.warnings],
			}
		},
	},
)
