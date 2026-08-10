import { z } from 'zod'
import {
	callerContextFields,
	errorFields,
	logMcpEvent,
} from '#mcp/observability.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	type Capability,
	type CapabilityDefinition,
	type CapabilityJsonSchema,
	type CapabilitySchemaDefinition,
	type InferCapabilitySchema,
} from './types.ts'
import {
	createCapabilityTypeName,
	createSchemaTypeDefinition,
} from './schema-type-definitions.ts'
import { assertCallerCanAccessCapability } from './access-control.ts'

// Normalize capability authoring input into the JSON-Schema-based shape
// consumed by the registry and sandbox search surface.
export function defineCapability<
	TInputSchema extends CapabilitySchemaDefinition,
	TOutputSchema extends CapabilitySchemaDefinition | undefined = undefined,
>(definition: CapabilityDefinition<TInputSchema, TOutputSchema>): Capability {
	const inputParser = createSchemaParser(definition.inputSchema)
	const outputParser = definition.outputSchema
		? createSchemaParser(definition.outputSchema)
		: null
	const keywords = mergeKeywords(definition.keywords, definition.tags)
	const source = definition.source ?? 'builtin'

	// Derived schema artifacts (JSON Schema conversion + TypeScript type-text
	// generation) are deferred to first access: `defineCapability` runs at
	// module scope for every builtin capability, and computing these for ~99
	// capabilities burned ~100 ms of isolate cold-start CPU before anything
	// needed them. Getters keep the `Capability` shape unchanged while moving
	// the cost to the first registry/search/execute use per isolate.
	let derivedMemo: {
		inputSchema: CapabilityJsonSchema
		outputSchema: CapabilityJsonSchema | undefined
		inputTypeDefinition: string
		outputTypeDefinition: string | undefined
	} | null = null
	const derived = () => {
		if (!derivedMemo) {
			const inputSchema = toJsonSchema(definition.inputSchema)
			const outputSchema = definition.outputSchema
				? toJsonSchema(definition.outputSchema)
				: undefined
			derivedMemo = {
				inputSchema,
				outputSchema,
				inputTypeDefinition: createSchemaTypeDefinition({
					jsonSchema: inputSchema,
					typeName: createCapabilityTypeName(definition.name, 'Input'),
				}),
				outputTypeDefinition: outputSchema
					? createSchemaTypeDefinition({
							jsonSchema: outputSchema,
							typeName: createCapabilityTypeName(definition.name, 'Output'),
						})
					: undefined,
			}
		}
		return derivedMemo
	}

	return {
		name: definition.name,
		domain: definition.domain,
		description: definition.description,
		keywords,
		readOnly: definition.readOnly ?? false,
		idempotent: definition.idempotent ?? false,
		destructive: definition.destructive ?? false,
		...(definition.requiredRole
			? { requiredRole: definition.requiredRole }
			: {}),
		...(definition.requiredPermission
			? { requiredPermission: definition.requiredPermission }
			: {}),
		...(definition.featureFlag ? { featureFlag: definition.featureFlag } : {}),
		source,
		...(definition.remoteConnector
			? { remoteConnector: definition.remoteConnector }
			: {}),
		...(definition.mcpServer ? { mcpServer: definition.mcpServer } : {}),
		...(definition.openApi ? { openApi: definition.openApi } : {}),
		get inputSchema() {
			return derived().inputSchema
		},
		get outputSchema() {
			return derived().outputSchema
		},
		get inputTypeDefinition() {
			return derived().inputTypeDefinition
		},
		get outputTypeDefinition() {
			return derived().outputTypeDefinition
		},
		async handler(args, ctx) {
			const startedAt = performance.now()
			const { baseUrl, hasUser, userId, storageId } = callerContextFields(
				ctx.callerContext,
			)
			const mcpCallerFields = {
				baseUrl,
				hasUser,
				userId,
				...(storageId ? { storageId } : {}),
			}
			await assertCallerCanAccessCapability(ctx.callerContext, definition, {
				env: ctx.env,
			})

			let parsedArgs: InferCapabilitySchema<TInputSchema>
			try {
				parsedArgs = inputParser(args) as InferCapabilitySchema<TInputSchema>
			} catch (error) {
				const callerError = createCapabilityValidationError(
					error,
					definition.name,
					'input',
				)
				const { errorName, errorMessage } = errorFields(callerError)
				logMcpEvent({
					category: 'mcp',
					tool: 'capability',
					capabilityName: definition.name,
					domain: definition.domain,
					capabilitySource: source,
					outcome: 'failure',
					durationMs: Math.round(performance.now() - startedAt),
					...mcpCallerFields,
					failurePhase: 'parse_input',
					errorName,
					errorMessage,
					cause: callerError,
				})
				throw callerError
			}

			let result: Awaited<ReturnType<typeof definition.handler>>
			try {
				result = await definition.handler(parsedArgs, ctx)
			} catch (error) {
				const { errorName, errorMessage } = errorFields(error)
				logMcpEvent({
					category: 'mcp',
					tool: 'capability',
					capabilityName: definition.name,
					domain: definition.domain,
					capabilitySource: source,
					outcome: 'failure',
					durationMs: Math.round(performance.now() - startedAt),
					...mcpCallerFields,
					failurePhase: 'handler',
					errorName,
					errorMessage,
					cause: error,
				})
				throw error
			}

			try {
				const finalized = outputParser ? outputParser(result) : result
				logMcpEvent({
					category: 'mcp',
					tool: 'capability',
					capabilityName: definition.name,
					domain: definition.domain,
					capabilitySource: source,
					outcome: 'success',
					durationMs: Math.round(performance.now() - startedAt),
					...mcpCallerFields,
				})
				return finalized
			} catch (error) {
				const validationError = createCapabilityValidationError(
					error,
					definition.name,
					'output',
				)
				const { errorName, errorMessage } = errorFields(validationError)
				logMcpEvent({
					category: 'mcp',
					tool: 'capability',
					capabilityName: definition.name,
					domain: definition.domain,
					capabilitySource: source,
					outcome: 'failure',
					durationMs: Math.round(performance.now() - startedAt),
					...mcpCallerFields,
					failurePhase: 'parse_output',
					errorName,
					errorMessage,
					cause: validationError,
				})
				throw validationError
			}
		},
	}
}

function createCapabilityValidationError(
	error: unknown,
	capabilityName: string,
	valueKind: 'input' | 'output',
) {
	if (!(error instanceof z.ZodError)) return error

	if (valueKind === 'input') {
		return new McpCallerError(
			[
				`Invalid input for capability "${capabilityName}".`,
				z.prettifyError(error),
				`Repair: Call search({ entity: "${capabilityName}:capability" }) for the exact input shape.`,
			].join('\n'),
			{ cause: error },
		)
	}

	return new Error(
		[
			`Capability "${capabilityName}" returned an invalid output shape.`,
			z.prettifyError(error),
			'This is a capability implementation error; changing the input shape will not repair it.',
		].join('\n'),
		{ cause: error },
	)
}

function mergeKeywords(
	keywords: Array<string> | undefined,
	tags: Array<string> | undefined,
) {
	return Array.from(new Set([...(keywords ?? []), ...(tags ?? [])]))
}

function createSchemaParser(schema: CapabilitySchemaDefinition) {
	if (isZodSchema(schema)) {
		return (value: unknown) => schema.parse(value)
	}

	return (value: unknown) => value
}

function toJsonSchema(
	schema: CapabilitySchemaDefinition,
): CapabilityJsonSchema {
	if (isZodSchema(schema)) {
		return normalizeJsonSchemaDefaultsOptional(
			z.toJSONSchema(schema),
		) as CapabilityJsonSchema
	}

	return schema
}

function normalizeJsonSchemaDefaultsOptional(schema: unknown): unknown {
	if (!schema || typeof schema !== 'object') return schema
	if (Array.isArray(schema)) {
		return schema.map((item) => normalizeJsonSchemaDefaultsOptional(item))
	}

	const normalizedEntries = Object.entries(schema).map(([key, value]) => [
		key,
		normalizeJsonSchemaDefaultsOptional(value),
	])
	const normalizedSchema = Object.fromEntries(normalizedEntries) as Record<
		string,
		unknown
	>

	const properties = normalizedSchema.properties
	if (
		properties &&
		typeof properties === 'object' &&
		!Array.isArray(properties) &&
		Array.isArray(normalizedSchema.required)
	) {
		const required = normalizedSchema.required.filter(
			(propertyName): propertyName is string =>
				typeof propertyName === 'string',
		)
		const optionalByDefault = required.filter((propertyName) => {
			const propertySchema = (properties as Record<string, unknown>)[
				propertyName
			]
			return (
				propertySchema &&
				typeof propertySchema === 'object' &&
				!Array.isArray(propertySchema) &&
				'default' in propertySchema
			)
		})

		if (optionalByDefault.length > 0) {
			const nextRequired = required.filter(
				(propertyName) => !optionalByDefault.includes(propertyName),
			)

			if (nextRequired.length > 0) {
				normalizedSchema.required = nextRequired
			} else {
				delete normalizedSchema.required
			}
		}
	}

	return normalizedSchema
}

function isZodSchema(schema: CapabilitySchemaDefinition): schema is z.ZodType {
	return schema instanceof z.ZodType
}
