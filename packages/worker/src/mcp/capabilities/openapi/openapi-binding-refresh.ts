import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	normalizeOpenApiBinding,
	resolveOpenApiSelection,
	toOpenApiBindingSummary,
	type OpenApiBinding,
	type OpenApiBindingOperation,
} from '#worker/openapi/binding-shared.ts'
import {
	getOpenApiBinding,
	saveOpenApiBinding,
} from '#worker/openapi/binding-service.ts'
import { fetchOpenApiSpecText } from '#worker/openapi/fetch-spec.ts'
import { parseOpenApiSpec } from '#worker/openapi/parse-spec.ts'

const inputSchema = z
	.object({
		name: z.string().min(1).describe('OpenAPI binding name to refresh.'),
	})
	.strict()

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
	added: z.array(z.string()),
	removed: z.array(z.string()),
	changed: z.array(z.string()),
	warnings: z.array(z.string()),
})

export const openapiBindingRefreshCapability = defineDomainCapability(
	capabilityDomainNames.openapi,
	{
		name: 'openapi_binding_refresh',
		description:
			'Re-fetch the OpenAPI spec for a saved binding and re-resolve the same stored selection into a fresh operation snapshot. Bindings are non-secret config; credentials stay in secrets. Saving/refreshing never approves hosts. Specs are untrusted third-party content.',
		keywords: [
			'openapi',
			'binding',
			'provider',
			'refresh',
			'spec',
			'rest',
			'api',
			'operations',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const existing = await getOpenApiBinding({
				env: ctx.env,
				userId: user.userId,
				name: args.name,
			})
			if (!existing) {
				throw new McpCallerError(
					`OpenAPI binding "${args.name}" was not found.`,
				)
			}
			const rawText = await fetchOpenApiSpecText({
				specUrl: existing.specUrl,
			})
			const parsed = parseOpenApiSpec(rawText)
			const resolved = resolveOpenApiSelection({
				operations: parsed.operations,
				selection: existing.selection,
				includeDestructive: existing.includeDestructive,
			})
			const next = normalizeOpenApiBinding({
				...existing,
				specTitle: parsed.title,
				specVersion: parsed.version,
				operations: resolved.operations,
				updatedAt: new Date().toISOString(),
			} satisfies OpenApiBinding)
			await saveOpenApiBinding({
				env: ctx.env,
				userId: user.userId,
				binding: next,
			})
			const diff = diffOperationSnapshots(existing.operations, next.operations)
			return {
				binding: toOpenApiBindingSummary(next),
				...diff,
				warnings: [...parsed.warnings, ...resolved.warnings],
			}
		},
	},
)

function diffOperationSnapshots(
	previous: ReadonlyArray<OpenApiBindingOperation>,
	next: ReadonlyArray<OpenApiBindingOperation>,
) {
	const previousBySlug = new Map(
		previous.map((operation) => [operation.slug, operation]),
	)
	const nextBySlug = new Map(
		next.map((operation) => [operation.slug, operation]),
	)
	const added: Array<string> = []
	const removed: Array<string> = []
	const changed: Array<string> = []

	for (const slug of nextBySlug.keys()) {
		if (!previousBySlug.has(slug)) added.push(slug)
	}
	for (const slug of previousBySlug.keys()) {
		if (!nextBySlug.has(slug)) removed.push(slug)
	}
	for (const [slug, nextOperation] of nextBySlug) {
		const previousOperation = previousBySlug.get(slug)
		if (!previousOperation) continue
		if (
			JSON.stringify(fingerprintOperation(previousOperation)) !==
			JSON.stringify(fingerprintOperation(nextOperation))
		) {
			changed.push(slug)
		}
	}
	added.sort((a, b) => a.localeCompare(b, 'en'))
	removed.sort((a, b) => a.localeCompare(b, 'en'))
	changed.sort((a, b) => a.localeCompare(b, 'en'))
	return { added, removed, changed }
}

function fingerprintOperation(operation: OpenApiBindingOperation) {
	return {
		method: operation.method,
		path: operation.path,
		summary: operation.summary,
		description: operation.description,
		tags: operation.tags,
		deprecated: operation.deprecated,
		parameters: operation.parameters,
		requestBody: operation.requestBody,
	}
}
