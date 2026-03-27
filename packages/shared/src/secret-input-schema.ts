export const secretInputSchemaFlag = 'x-kody-secret'

// Prefer this helper over hand-editing JSON Schema properties for secret inputs.
export function markSecretInputFields(
	schema: Record<string, unknown>,
	fieldNames: Array<string>,
) {
	const properties = schema.properties
	if (
		!properties ||
		typeof properties !== 'object' ||
		Array.isArray(properties)
	) {
		return schema
	}

	let changed = false
	const nextProperties = Object.fromEntries(
		Object.entries(properties).map(([key, value]) => {
			if (
				!fieldNames.includes(key) ||
				!value ||
				typeof value !== 'object' ||
				Array.isArray(value)
			) {
				return [key, value]
			}
			changed = true
			return [key, { ...value, [secretInputSchemaFlag]: true }]
		}),
	)

	return changed ? { ...schema, properties: nextProperties } : schema
}
