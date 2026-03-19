import { z } from 'zod'
import {
	type Capability,
	type CapabilityDefinition,
	type CapabilityJsonSchema,
	type CapabilitySchemaDefinition,
	type InferCapabilitySchema,
} from './types.ts'

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

	return {
		name: definition.name,
		domain: definition.domain,
		description: definition.description,
		tags: definition.tags ?? [],
		keywords: definition.keywords ?? [],
		readOnly: definition.readOnly ?? false,
		idempotent: definition.idempotent ?? false,
		destructive: definition.destructive ?? false,
		inputSchema: toJsonSchema(definition.inputSchema),
		...(definition.outputSchema
			? { outputSchema: toJsonSchema(definition.outputSchema) }
			: {}),
		async handler(args, ctx) {
			const parsedArgs = inputParser(args) as InferCapabilitySchema<TInputSchema>
			const result = await definition.handler(parsedArgs, ctx)
			return outputParser ? outputParser(result) : result
		},
	}
}

function createSchemaParser(schema: CapabilitySchemaDefinition) {
	if (isZodSchema(schema)) {
		return (value: unknown) => schema.parse(value)
	}

	return (value: unknown) => value
}

function toJsonSchema(schema: CapabilitySchemaDefinition): CapabilityJsonSchema {
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
			(propertyName): propertyName is string => typeof propertyName === 'string',
		)
		const optionalByDefault = required.filter((propertyName) => {
			const propertySchema = (properties as Record<string, unknown>)[propertyName]
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

function isZodSchema(
	schema: CapabilitySchemaDefinition,
): schema is z.ZodType {
	return schema instanceof z.ZodType
}
