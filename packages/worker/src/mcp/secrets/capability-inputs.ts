import { secretInputSchemaFlag } from '@kody-internal/shared/secret-input-schema.ts'
import {
	buildSecretPlaceholder,
	parseSecretPlaceholders,
	replaceSecretPlaceholders,
	type ReferencedSecret,
} from '#mcp/secrets/placeholders.ts'

export { secretInputSchemaFlag }

export async function resolveCapabilityInputSecrets(input: {
	schema: unknown
	value: unknown
	resolveSecretValue: (secret: ReferencedSecret) => Promise<string>
}) {
	return resolveSchemaValue(input.schema, input.value, input.resolveSecretValue)
}

async function resolveSchemaValue(
	schema: unknown,
	value: unknown,
	resolveSecretValue: (secret: ReferencedSecret) => Promise<string>,
): Promise<unknown> {
	if (typeof value === 'string' && isSecretInputSchema(schema)) {
		return resolveStringPlaceholders(value, resolveSecretValue)
	}

	if (Array.isArray(value)) {
		const itemSchema = getArrayItemSchema(schema)
		if (!itemSchema) return value

		const nextItems = await Promise.all(
			value.map((item) =>
				resolveSchemaValue(itemSchema, item, resolveSecretValue),
			),
		)
		return nextItems.some((item, index) => item !== value[index])
			? nextItems
			: value
	}

	if (isRecord(value)) {
		const propertySchemas = getSchemaProperties(schema)
		const additionalProperties = getAdditionalPropertiesSchema(schema)
		if (!propertySchemas && !additionalProperties) return value

		let changed = false
		const nextEntries = await Promise.all(
			Object.entries(value).map(async ([key, entryValue]) => {
				const entrySchema = propertySchemas?.[key] ?? additionalProperties
				if (!entrySchema) return [key, entryValue] as const
				const nextValue = await resolveSchemaValue(
					entrySchema,
					entryValue,
					resolveSecretValue,
				)
				if (nextValue !== entryValue) changed = true
				return [key, nextValue] as const
			}),
		)

		return changed ? Object.fromEntries(nextEntries) : value
	}

	return value
}

async function resolveStringPlaceholders(
	value: string,
	resolveSecretValue: (secret: ReferencedSecret) => Promise<string>,
) {
	const referencedSecrets = parseSecretPlaceholders(value)
	if (referencedSecrets.length === 0) return value

	const replacements = new Map<string, string>()
	for (const secret of referencedSecrets) {
		const placeholder = buildSecretPlaceholder(secret)
		if (replacements.has(placeholder)) continue
		replacements.set(placeholder, await resolveSecretValue(secret))
	}
	return replaceSecretPlaceholders(value, replacements)
}

function isSecretInputSchema(schema: unknown) {
	if (!isRecord(schema)) return false
	return schema[secretInputSchemaFlag] === true
}

function getSchemaProperties(schema: unknown) {
	if (!isRecord(schema)) return null
	const properties = schema.properties
	return isRecord(properties) ? properties : null
}

function getArrayItemSchema(schema: unknown) {
	if (!isRecord(schema)) return null
	const items = schema.items
	return items === undefined || Array.isArray(items) ? null : items
}

function getAdditionalPropertiesSchema(schema: unknown) {
	if (!isRecord(schema)) return null
	const additionalProperties = schema.additionalProperties
	return isRecord(additionalProperties) ? additionalProperties : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
