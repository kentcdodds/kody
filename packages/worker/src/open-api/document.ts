import { z } from 'zod'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { type BuiltCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import {
	apiTokenScopeDescriptions,
	apiTokenScopes,
	type ApiTokenScope,
} from '#worker/api-tokens/scopes.ts'
import { apiTokenIdleTtlDescription } from '#worker/api-tokens/service.ts'
import { apiErrorCodes } from './errors.ts'
import {
	apiOperationUsesQueryInputs,
	apiOperations,
	getApiOperationPathParams,
	resolveCapabilityOperationScope,
	type ApiOperation,
} from './operations.ts'
import { nativeApiOperationDefinitions } from './native-operations.ts'

export const openApiVersion = '3.1.0'
export const kodyApiVersion = '1.0.0'

type JsonSchema = Record<string, unknown>

type OpenApiParameter = {
	name: string
	in: 'path' | 'query'
	required: boolean
	description?: string
	schema: JsonSchema
	style?: 'form'
	explode?: boolean
}

type OpenApiOperation = {
	operationId: string
	summary: string
	description: string
	tags: Array<string>
	parameters?: Array<OpenApiParameter>
	requestBody?: {
		required: boolean
		content: { 'application/json': { schema: JsonSchema } }
	}
	responses: Record<string, unknown>
	security: Array<Record<string, Array<string>>>
	'x-kody-scope': ApiTokenScope | null
	'x-kody-read-only': boolean
	'x-kody-feature-flag'?: string
}

export type OpenApiDocument = {
	openapi: typeof openApiVersion
	info: Record<string, unknown>
	externalDocs?: { description: string; url: string }
	servers: Array<{ url: string }>
	tags: Array<{ name: string; description: string }>
	security: Array<Record<string, Array<string>>>
	paths: Record<string, Record<string, OpenApiOperation>>
	components: {
		schemas: Record<string, JsonSchema>
		responses: Record<string, unknown>
		securitySchemes: Record<string, unknown>
	}
}

/** Public interactive docs host (separate Worker; JSON stays on api.kody.codes). */
export const kodyApiDocsUrl = 'https://api-docs.kody.codes'

export type ResolvedApiOperation = {
	operation: ApiOperation
	description: string
	inputSchema: JsonSchema
	outputSchema: JsonSchema | null
	scope: ApiTokenScope | null
	readOnly: boolean
	featureFlag: string | null
}

const tagDescriptions: Record<ApiOperation['tag'], string> = {
	account: 'Account profile, usage, waiting items, export, and feedback.',
	search: 'Unified Kody search.',
	memories: 'Memories and the MCP server-instruction overlay.',
	secrets:
		'Secret metadata and writes. Secret values can be written but are never returned.',
	packages: 'Saved packages, sharing, and subscriptions.',
	repos: 'Repos and repo sessions (edit, check, commit, publish).',
	jobs: 'Package jobs and workflow runs.',
	webhooks: 'Package webhook URLs and deliveries.',
	email: 'Inboxes, messages, sender rules, destinations, and sending.',
	integrations: 'OAuth integrations and OAuth apps.',
	'mcp-servers': 'User-added MCP servers.',
	runs: 'Execution run history and triage.',
	storage: 'Durable storage export and SQL query.',
	community: 'Public packages in the community catalog, and profile.',
	tokens: 'Scoped, short-lived API tokens.',
	'capability-proxy':
		'Platform I/O for a local execute venue: CapabilityProxy hops (`kody:runtime` calls) and `POST /v1/local-execute/package-graph` (stamped `kody:@…` module download). Requires the `local-execute` scope and a scoped API token or CLI `kody login` MCP OAuth bearer.',
}

function stripSchemaMeta(schema: JsonSchema): JsonSchema {
	const { $schema: _schema, ...rest } = schema
	return rest
}

/**
 * Move `$defs` into `components.schemas` under an operation-scoped name and
 * rewrite `#/$defs/...` references so the schema is valid inside OpenAPI.
 */
function hoistDefs(
	schema: JsonSchema,
	prefix: string,
	componentSchemas: Record<string, JsonSchema>,
): JsonSchema {
	const defs = isRecord(schema['$defs']) ? schema['$defs'] : null
	const { $defs: _defs, ...rest } = stripSchemaMeta(schema)
	if (!defs) return rest
	const componentName = (name: string) =>
		`${prefix}_${name.replace(/[^A-Za-z0-9._-]/g, '_')}`
	const rewrite = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(rewrite)
		if (!isRecord(value)) return value
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => {
				if (
					key === '$ref' &&
					typeof entry === 'string' &&
					entry.startsWith('#/$defs/')
				) {
					return [
						key,
						`#/components/schemas/${componentName(entry.slice('#/$defs/'.length))}`,
					]
				}
				return [key, rewrite(entry)]
			}),
		)
	}
	for (const [name, definition] of Object.entries(defs)) {
		componentSchemas[componentName(name)] = rewrite(definition) as JsonSchema
	}
	return rewrite(rest) as JsonSchema
}

function summarize(description: string) {
	const firstLine = description.trim().split('\n')[0] ?? ''
	const sentence = /^(.+?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine
	return sentence.length > 120 ? `${sentence.slice(0, 117)}...` : sentence
}

function readProperties(schema: JsonSchema) {
	return isRecord(schema['properties'])
		? (schema['properties'] as Record<string, JsonSchema>)
		: {}
}

function readRequired(schema: JsonSchema) {
	return Array.isArray(schema['required'])
		? (schema['required'] as Array<string>)
		: []
}

export function resolveApiOperation(
	operation: ApiOperation,
	registry: BuiltCapabilityRegistry,
): ResolvedApiOperation {
	switch (operation.kind) {
		case 'native': {
			const definition = nativeApiOperationDefinitions[operation.operationId]
			return {
				operation,
				description: definition.description,
				inputSchema: z.toJSONSchema(definition.inputSchema) as JsonSchema,
				outputSchema: z.toJSONSchema(definition.outputSchema) as JsonSchema,
				scope: operation.scope,
				readOnly: definition.readOnly,
				featureFlag: null,
			}
		}
		case 'capability': {
			const capability = registry.capabilityMap[operation.operationId]
			if (!capability) {
				throw new Error(
					`Open API operation "${operation.operationId}" has no capability.`,
				)
			}
			return {
				operation,
				description: capability.description,
				inputSchema: capability.inputSchema as JsonSchema,
				outputSchema:
					(capability.outputSchema as JsonSchema | undefined) ?? null,
				scope: resolveCapabilityOperationScope(operation, capability),
				readOnly: capability.readOnly,
				featureFlag: capability.featureFlag ?? null,
			}
		}
		default: {
			const exhaustive: never = operation
			throw new Error(`Unhandled API operation: ${String(exhaustive)}`)
		}
	}
}

function buildOperation(
	resolved: ResolvedApiOperation,
	componentSchemas: Record<string, JsonSchema>,
): OpenApiOperation {
	const { operation } = resolved
	const inputSchema = hoistDefs(
		resolved.inputSchema,
		`${operation.operationId}Input`,
		componentSchemas,
	)
	const properties = readProperties(inputSchema)
	const required = new Set(readRequired(inputSchema))
	const pathParams = getApiOperationPathParams(operation.path)
	const omitted = new Set(
		operation.kind === 'capability' ? (operation.omitInputs ?? []) : [],
	)
	const parameters: Array<OpenApiParameter> = pathParams.map((name) => {
		const schema = properties[name] ?? { type: 'string' }
		return {
			name,
			in: 'path',
			required: true,
			...(typeof schema['description'] === 'string'
				? { description: schema['description'] }
				: {}),
			schema,
		}
	})
	const bodyEntries = Object.entries(properties).filter(
		([name]) => !pathParams.includes(name) && !omitted.has(name),
	)
	let requestBody: OpenApiOperation['requestBody']
	if (apiOperationUsesQueryInputs(operation.method)) {
		for (const [name, schema] of bodyEntries) {
			parameters.push({
				name,
				in: 'query',
				required: required.has(name),
				...(typeof schema['description'] === 'string'
					? { description: schema['description'] }
					: {}),
				schema,
				...(schema['type'] === 'array'
					? { style: 'form' as const, explode: true }
					: {}),
			})
		}
	} else {
		const bodyRequired = readRequired(inputSchema).filter(
			(name) => !pathParams.includes(name) && !omitted.has(name),
		)
		const {
			required: _required,
			properties: _properties,
			...rest
		} = inputSchema
		requestBody = {
			required: bodyRequired.length > 0,
			content: {
				'application/json': {
					schema: {
						...rest,
						type: 'object',
						properties: Object.fromEntries(bodyEntries),
						...(bodyRequired.length > 0 ? { required: bodyRequired } : {}),
					},
				},
			},
		}
	}
	const outputSchema = resolved.outputSchema
		? hoistDefs(
				resolved.outputSchema,
				`${operation.operationId}Output`,
				componentSchemas,
			)
		: {}
	return {
		operationId: operation.operationId,
		summary: summarize(resolved.description),
		description: resolved.description,
		tags: [operation.tag],
		...(parameters.length > 0 ? { parameters } : {}),
		...(requestBody ? { requestBody } : {}),
		responses: {
			'200': {
				description: 'Success.',
				content: { 'application/json': { schema: outputSchema } },
			},
			default: { $ref: '#/components/responses/Error' },
		},
		security: [{ apiToken: resolved.scope ? [resolved.scope] : [] }],
		'x-kody-scope': resolved.scope,
		'x-kody-read-only': resolved.readOnly,
		...(resolved.featureFlag
			? { 'x-kody-feature-flag': resolved.featureFlag }
			: {}),
	}
}

function buildDocumentBody(registry: BuiltCapabilityRegistry) {
	const componentSchemas: Record<string, JsonSchema> = {
		Error: {
			type: 'object',
			required: ['error'],
			properties: {
				error: {
					type: 'object',
					required: ['code', 'message'],
					properties: {
						code: { type: 'string', enum: [...apiErrorCodes] },
						message: { type: 'string' },
						details: {},
					},
				},
			},
		},
	}
	const paths: OpenApiDocument['paths'] = {}
	for (const operation of apiOperations) {
		const resolved = resolveApiOperation(operation, registry)
		const pathItem = (paths[operation.path] ??= {})
		pathItem[operation.method.toLowerCase()] = buildOperation(
			resolved,
			componentSchemas,
		)
	}
	const scopeList = apiTokenScopes
		.map((scope) => `- \`${scope}\`: ${apiTokenScopeDescriptions[scope]}`)
		.join('\n')
	return {
		openapi: openApiVersion,
		info: {
			title: 'Kody API',
			version: kodyApiVersion,
			description: [
				'HTTP API for a Kody account. Versioned under `/v1`; changes within v1 are additive.',
				'',
				'Authenticate with `Authorization: Bearer kody_at_…`. Tokens are minted by the MCP `api` tool (`tokenCreate`) or by another token with `tokens:write`, and each carries explicit scopes.',
				apiTokenIdleTtlDescription(),
				'',
				'Errors use `{ "error": { "code", "message", "details"? } }`. Requests are rate limited per IP and per token (HTTP 429 with `Retry-After`).',
				'',
				'`operationId` values match Kody capability names, so the same ids work with the MCP `api` tool (`{ operationId, params }`, where params hold path, query, and body fields flat).',
				'',
				`Interactive docs: ${kodyApiDocsUrl}`,
				'',
				'Scopes:',
				scopeList,
			].join('\n'),
		},
		externalDocs: {
			description: 'Interactive Kody API docs (Scalar)',
			url: kodyApiDocsUrl,
		},
		tags: Object.entries(tagDescriptions).map(([name, description]) => ({
			name,
			description,
		})),
		security: [{ apiToken: [] }],
		paths,
		components: {
			schemas: componentSchemas,
			responses: {
				Error: {
					description: 'Error.',
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/Error' },
						},
					},
				},
			},
			securitySchemes: {
				apiToken: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'kody_at_<id>_<secret>',
					description:
						'Scoped Kody API token. Each operation lists its required scope in `security` and `x-kody-scope`.',
				},
			},
		},
	} satisfies Omit<OpenApiDocument, 'servers'>
}

let documentBodyMemo: Promise<Omit<OpenApiDocument, 'servers'>> | null = null

/** The OpenAPI document, built once per isolate. */
export async function buildOpenApiDocument(input: {
	serverUrl: string
}): Promise<OpenApiDocument> {
	documentBodyMemo ??= getStaticRegistry()
		.then((registry) => buildDocumentBody(registry))
		.catch((error: unknown) => {
			documentBodyMemo = null
			throw error
		})
	const body = await documentBodyMemo
	return { ...body, servers: [{ url: input.serverUrl }] }
}
