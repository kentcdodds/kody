type CompressSchemaOptions = {
	stripRootObjectType?: boolean
}

type CompressSchemaContext = {
	isRoot: boolean
	propertyName?: string
	stripRootObjectType: boolean
}

const propertyMapKeys = new Set([
	'properties',
	'definitions',
	'$defs',
	'patternProperties',
])
const compositionArrayKeys = new Set(['allOf', 'anyOf', 'oneOf'])
const compositionObjectKeys = new Set(['not', 'if', 'then', 'else'])

export function compressSchemaForLlm(
	schema: unknown,
	options: CompressSchemaOptions = {},
): unknown {
	return compressSchemaNode(schema, {
		isRoot: true,
		propertyName: undefined,
		stripRootObjectType: options.stripRootObjectType ?? true,
	})
}

function compressSchemaNode(
	node: unknown,
	context: CompressSchemaContext,
): unknown {
	if (!node || typeof node !== 'object') {
		return node
	}

	if (Array.isArray(node)) {
		return node.map((item) =>
			compressSchemaNode(item, {
				isRoot: false,
				propertyName: undefined,
				stripRootObjectType: false,
			}),
		)
	}

	const record = node as Record<string, unknown>
	const result: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(record)) {
		if (key === '$schema') continue
		if (key === 'additionalProperties' && value === false) continue
		if (
			context.isRoot &&
			context.stripRootObjectType &&
			key === 'type' &&
			value === 'object'
		) {
			continue
		}
		if (
			key === 'title' &&
			typeof value === 'string' &&
			context.propertyName &&
			isRedundantLabel(value, context.propertyName)
		) {
			continue
		}
		if (
			key === 'description' &&
			typeof value === 'string' &&
			context.propertyName &&
			isRedundantLabel(value, context.propertyName)
		) {
			continue
		}
		if (
			propertyMapKeys.has(key) &&
			value &&
			typeof value === 'object' &&
			!Array.isArray(value)
		) {
			const mapValue = value as Record<string, unknown>
			result[key] = Object.fromEntries(
				Object.entries(mapValue).map(([propName, propSchema]) => [
					propName,
					compressSchemaNode(propSchema, {
						isRoot: false,
						propertyName: propName,
						stripRootObjectType: false,
					}),
				]),
			)
			continue
		}
		if (compositionArrayKeys.has(key)) {
			result[key] = Array.isArray(value)
				? value.map((item) =>
						compressSchemaNode(item, {
							isRoot: false,
							propertyName: undefined,
							stripRootObjectType: false,
						}),
					)
				: value
			continue
		}
		if (compositionObjectKeys.has(key)) {
			result[key] = compressSchemaNode(value, {
				isRoot: false,
				propertyName: undefined,
				stripRootObjectType: false,
			})
			continue
		}
		if (key === 'items') {
			if (Array.isArray(value)) {
				result[key] = value.map((item) =>
					compressSchemaNode(item, {
						isRoot: false,
						propertyName: undefined,
						stripRootObjectType: false,
					}),
				)
				continue
			}
			result[key] = compressSchemaNode(value, {
				isRoot: false,
				propertyName: undefined,
				stripRootObjectType: false,
			})
			continue
		}
		if (Array.isArray(value)) {
			result[key] = value.map((item) =>
				compressSchemaNode(item, {
					isRoot: false,
					propertyName: undefined,
					stripRootObjectType: false,
				}),
			)
			continue
		}

		result[key] = compressSchemaNode(value, {
			isRoot: false,
			propertyName: undefined,
			stripRootObjectType: false,
		})
	}

	return result
}

function isRedundantLabel(label: string, propertyName: string) {
	return normalizeLabel(label) === normalizeLabel(propertyName)
}

function normalizeLabel(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '')
}
