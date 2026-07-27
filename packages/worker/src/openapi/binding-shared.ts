import { z } from 'zod'
import { openApiBoundAuthSchema } from '#worker/openapi/auth-binding.ts'
import {
	type OpenApiHttpMethod,
	type OpenApiOperation,
	type OpenApiParameter,
	type OpenApiRequestBody,
} from '#worker/openapi/spec-types.ts'

export const openApiBindingNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const maxOpenApiBindingOperations = 100
/** Soft cap for registry/synthesis practicality; narrow selection if exceeded. */
export const maxOpenApiBindingSerializedBytes = 900_000

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

export const openApiBindingSelectionSchema = z
	.object({
		operationIds: z
			.array(z.string().min(1))
			.optional()
			.describe(
				'Operation slugs from openapi_spec_summarize or raw OpenAPI operationId values; both match.',
			),
		tags: z.array(z.string().min(1)).optional(),
		pathPrefixes: z.array(z.string().min(1)).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const hasOperationIds = (value.operationIds?.length ?? 0) > 0
		const hasTags = (value.tags?.length ?? 0) > 0
		const hasPathPrefixes = (value.pathPrefixes?.length ?? 0) > 0
		if (!hasOperationIds && !hasTags && !hasPathPrefixes) {
			ctx.addIssue({
				code: 'custom',
				message:
					'selection requires at least one of operationIds, tags, or pathPrefixes.',
			})
		}
	})

export const openApiBindingOperationSchema = z
	.object({
		slug: z.string().min(1),
		operationId: z.string().nullable(),
		method: z.enum([
			'get',
			'put',
			'post',
			'delete',
			'options',
			'head',
			'patch',
			'trace',
		]),
		path: z.string().min(1),
		summary: z.string().nullable(),
		description: z.string().nullable(),
		tags: z.array(z.string()),
		deprecated: z.boolean(),
		parameters: z.array(
			z.object({
				name: z.string().min(1),
				location: z.enum(['path', 'query', 'header', 'cookie']),
				required: z.boolean(),
				description: z.string().nullable(),
				schema: z.record(z.string(), z.unknown()).nullable(),
			}),
		),
		requestBody: z
			.object({
				required: z.boolean(),
				contentType: z.string().nullable(),
				schema: z.record(z.string(), z.unknown()).nullable(),
			})
			.nullable(),
	})
	.strict()

export type OpenApiBindingOperation = z.infer<
	typeof openApiBindingOperationSchema
>

export const openApiBindingSchema = z
	.object({
		name: z.string().regex(openApiBindingNamePattern, {
			message:
				'name must match ^[a-z0-9][a-z0-9_-]{0,63}$ (used in kody.openapi["<name>"]).',
		}),
		specUrl: httpsUrlSchema,
		apiBaseUrl: httpsUrlSchema,
		description: z.string().nullable().optional(),
		auth: openApiBoundAuthSchema,
		selection: openApiBindingSelectionSchema,
		includeDestructive: z.boolean(),
		specTitle: z.string().nullable(),
		specVersion: z.string().nullable(),
		operations: z
			.array(openApiBindingOperationSchema)
			.min(1)
			.max(maxOpenApiBindingOperations),
		updatedAt: z.string().min(1),
	})
	.strict()

export type OpenApiBinding = z.infer<typeof openApiBindingSchema>

export const openApiBindingSaveInputSchema = z
	.object({
		name: z.string().regex(openApiBindingNamePattern, {
			message:
				'name must match ^[a-z0-9][a-z0-9_-]{0,63}$ (used in kody.openapi["<name>"]).',
		}),
		specUrl: httpsUrlSchema,
		apiBaseUrl: httpsUrlSchema,
		auth: openApiBoundAuthSchema,
		selection: openApiBindingSelectionSchema,
		includeDestructive: z.boolean().optional().default(false),
		description: z.string().nullable().optional(),
	})
	.strict()

export type OpenApiBindingSaveInput = z.infer<
	typeof openApiBindingSaveInputSchema
>

export type OpenApiBindingSelection = z.infer<
	typeof openApiBindingSelectionSchema
>

export type ResolveOpenApiSelectionResult = {
	operations: Array<OpenApiBindingOperation>
	warnings: Array<string>
}

export function normalizeOpenApiBinding(value: OpenApiBinding): OpenApiBinding {
	return {
		...value,
		name: value.name.trim(),
		specUrl: value.specUrl.trim(),
		apiBaseUrl: normalizeApiBaseUrl(value.apiBaseUrl),
		description: value.description?.trim() || null,
		includeDestructive: Boolean(value.includeDestructive),
		specTitle: value.specTitle?.trim() || null,
		specVersion: value.specVersion?.trim() || null,
		selection: normalizeSelection(value.selection),
		operations: value.operations.map(toBindingOperation),
		updatedAt: value.updatedAt,
	}
}

export function parseOpenApiBinding(
	value: unknown,
	fallbackName: string | null,
): OpenApiBinding | null {
	const record =
		value && typeof value === 'object' && !Array.isArray(value) ? value : null
	const candidate =
		record && typeof (record as Record<string, unknown>).name === 'string'
			? record
			: record && fallbackName
				? { ...record, name: fallbackName }
				: record
	const parsed = openApiBindingSchema.safeParse(candidate)
	if (!parsed.success) return null
	return normalizeOpenApiBinding(parsed.data)
}

export function toBindingOperation(
	operation: Pick<
		OpenApiOperation,
		| 'slug'
		| 'operationId'
		| 'method'
		| 'path'
		| 'summary'
		| 'description'
		| 'tags'
		| 'deprecated'
		| 'parameters'
		| 'requestBody'
	>,
): OpenApiBindingOperation {
	return {
		slug: operation.slug,
		operationId: operation.operationId,
		method: operation.method,
		path: operation.path,
		summary: operation.summary,
		description: operation.description,
		tags: [...operation.tags],
		deprecated: Boolean(operation.deprecated),
		parameters: operation.parameters.map(normalizeParameter),
		requestBody: operation.requestBody
			? normalizeRequestBody(operation.requestBody)
			: null,
	}
}

export function resolveOpenApiSelection(input: {
	operations: ReadonlyArray<OpenApiOperation>
	selection: OpenApiBindingSelection
	includeDestructive: boolean
}): ResolveOpenApiSelectionResult {
	const selection = normalizeSelection(input.selection)
	const warnings: Array<string> = []
	const matched = new Map<string, OpenApiOperation>()

	for (const operation of input.operations) {
		if (!operationMatchesSelection(operation, selection)) continue
		matched.set(operation.slug, operation)
	}

	const explicitIds = new Set(selection.operationIds ?? [])
	const isExplicitlySelected = (operation: OpenApiOperation) =>
		explicitIds.has(operation.slug) ||
		(operation.operationId != null && explicitIds.has(operation.operationId))
	const kept: Array<OpenApiBindingOperation> = []
	for (const operation of matched.values()) {
		if (operation.method === 'delete' && !input.includeDestructive) {
			if (isExplicitlySelected(operation)) {
				warnings.push(
					`Excluded destructive DELETE operation "${operation.slug}" because includeDestructive is false.`,
				)
			}
			continue
		}
		kept.push(toBindingOperation(operation))
	}

	kept.sort((left, right) => left.slug.localeCompare(right.slug, 'en'))

	if (kept.length === 0) {
		throw new Error(
			'OpenAPI binding selection matched 0 operations. Broaden operationIds, tags, or pathPrefixes, or set includeDestructive if you intended DELETE operations.',
		)
	}
	if (kept.length > maxOpenApiBindingOperations) {
		throw new Error(
			`OpenAPI binding selection matched ${kept.length} operations, exceeding the max of ${maxOpenApiBindingOperations}. Narrow the selection — Kody never auto-exposes an entire large spec.`,
		)
	}

	return { operations: kept, warnings }
}

export function assertOpenApiBindingWithinSizeLimit(binding: OpenApiBinding) {
	const serialized = JSON.stringify(binding)
	const bytes = new TextEncoder().encode(serialized).byteLength
	if (bytes > maxOpenApiBindingSerializedBytes) {
		throw new Error(
			`OpenAPI binding snapshot is ${bytes} bytes, exceeding the ${maxOpenApiBindingSerializedBytes}-byte registry/synthesis size cap. Narrow the selection (fewer operations or smaller schemas) and try again.`,
		)
	}
	return serialized
}

export function authKindOf(auth: OpenApiBinding['auth']): string {
	return auth.kind
}

export function normalizeApiBaseUrl(apiBaseUrl: string) {
	const trimmed = apiBaseUrl.trim()
	return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function normalizeSelection(
	selection: OpenApiBindingSelection,
): OpenApiBindingSelection {
	return {
		...(selection.operationIds
			? {
					operationIds: selection.operationIds
						.map((value) => value.trim())
						.filter(Boolean),
				}
			: {}),
		...(selection.tags
			? {
					tags: selection.tags.map((value) => value.trim()).filter(Boolean),
				}
			: {}),
		...(selection.pathPrefixes
			? {
					pathPrefixes: selection.pathPrefixes
						.map((value) => value.trim())
						.filter(Boolean),
				}
			: {}),
	}
}

function operationMatchesSelection(
	operation: OpenApiOperation,
	selection: OpenApiBindingSelection,
) {
	if (selection.operationIds && selection.operationIds.length > 0) {
		if (selection.operationIds.includes(operation.slug)) return true
		if (
			operation.operationId != null &&
			selection.operationIds.includes(operation.operationId)
		) {
			return true
		}
	}
	if (selection.tags && selection.tags.length > 0) {
		const operationTags = new Set(
			operation.tags.map((tag) => tag.trim().toLowerCase()),
		)
		for (const tag of selection.tags) {
			if (operationTags.has(tag.toLowerCase())) return true
		}
	}
	if (selection.pathPrefixes && selection.pathPrefixes.length > 0) {
		for (const prefix of selection.pathPrefixes) {
			if (operation.path.startsWith(prefix)) return true
		}
	}
	return false
}

function normalizeParameter(parameter: OpenApiParameter): OpenApiParameter {
	return {
		name: parameter.name,
		location: parameter.location,
		required: Boolean(parameter.required),
		description: parameter.description,
		schema:
			parameter.schema && typeof parameter.schema === 'object'
				? parameter.schema
				: null,
	}
}

function normalizeRequestBody(body: OpenApiRequestBody): OpenApiRequestBody {
	return {
		required: Boolean(body.required),
		contentType: body.contentType,
		schema: body.schema && typeof body.schema === 'object' ? body.schema : null,
	}
}

export type OpenApiBindingSummary = {
	name: string
	specUrl: string
	apiBaseUrl: string
	authKind: string
	operationCount: number
	updatedAt: string
	specTitle: string | null
	description: string | null
}

export function toOpenApiBindingSummary(
	binding: OpenApiBinding,
): OpenApiBindingSummary {
	return {
		name: binding.name,
		specUrl: binding.specUrl,
		apiBaseUrl: binding.apiBaseUrl,
		authKind: authKindOf(binding.auth),
		operationCount: binding.operations.length,
		updatedAt: binding.updatedAt,
		specTitle: binding.specTitle,
		description: binding.description ?? null,
	}
}

export type OpenApiBindingOperationInventoryItem = {
	slug: string
	method: OpenApiHttpMethod
	path: string
	summary: string | null
	deprecated: boolean
}

export function toOpenApiBindingOperationInventory(
	binding: OpenApiBinding,
): Array<OpenApiBindingOperationInventoryItem> {
	return binding.operations.map((operation) => ({
		slug: operation.slug,
		method: operation.method,
		path: operation.path,
		summary: operation.summary,
		deprecated: operation.deprecated,
	}))
}
