import { canonicalJsonStringify } from './canonical-json.ts'
import { isRecord } from './is-record.ts'

/**
 * Deliberately small JSON Schema subset for package-event payload contracts.
 * Only the keywords below are supported; schemas using anything else are
 * rejected at publish time so authors never depend on silently ignored
 * constraints. Validation is structural and side-effect free (no `$ref`,
 * no `pattern`, no format registry), which keeps it safe to run against
 * untrusted payloads in the dispatch path.
 */
export type JsonSchemaSubset = Record<string, unknown>

const supportedKeywords = new Set([
	'type',
	'description',
	'properties',
	'required',
	'additionalProperties',
	'items',
	'enum',
	'const',
	'minLength',
	'maxLength',
	'minimum',
	'maximum',
	'minItems',
	'maxItems',
])

const supportedTypes = new Set([
	'object',
	'array',
	'string',
	'number',
	'integer',
	'boolean',
	'null',
])

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function listSchemaTypes(schema: Record<string, unknown>): Array<string> {
	const type = schema['type']
	if (typeof type === 'string') return [type]
	if (Array.isArray(type)) {
		return type.filter((entry): entry is string => typeof entry === 'string')
	}
	return []
}

/**
 * Validate a schema definition against the supported subset. Returns an
 * empty array when the schema is usable with
 * {@link listJsonSchemaSubsetValueErrors}.
 */
export function listJsonSchemaSubsetProblems(
	schema: unknown,
	path = '#',
): Array<string> {
	if (!isRecord(schema)) {
		return [`${path} must be a JSON object schema.`]
	}
	const problems: Array<string> = []
	for (const keyword of Object.keys(schema)) {
		if (!supportedKeywords.has(keyword)) {
			problems.push(
				`${path} uses unsupported keyword "${keyword}". Supported keywords: ${[...supportedKeywords].join(', ')}.`,
			)
		}
	}
	if ('type' in schema) {
		const type = schema['type']
		const types =
			typeof type === 'string' ? [type] : Array.isArray(type) ? type : null
		if (!types || types.length === 0) {
			problems.push(`${path}.type must be a type name or array of type names.`)
		} else {
			for (const entry of types) {
				if (typeof entry !== 'string' || !supportedTypes.has(entry)) {
					problems.push(
						`${path}.type "${String(entry)}" is not supported. Supported types: ${[...supportedTypes].join(', ')}.`,
					)
				}
			}
		}
	}
	if ('description' in schema && typeof schema['description'] !== 'string') {
		problems.push(`${path}.description must be a string.`)
	}
	if ('properties' in schema) {
		const properties = schema['properties']
		if (!isRecord(properties)) {
			problems.push(`${path}.properties must be an object of schemas.`)
		} else {
			for (const [key, propertySchema] of Object.entries(properties)) {
				problems.push(
					...listJsonSchemaSubsetProblems(
						propertySchema,
						`${path}.properties["${key}"]`,
					),
				)
			}
		}
	}
	if ('required' in schema) {
		const required = schema['required']
		if (
			!Array.isArray(required) ||
			required.some((entry) => typeof entry !== 'string')
		) {
			problems.push(`${path}.required must be an array of property names.`)
		}
	}
	if (
		'additionalProperties' in schema &&
		typeof schema['additionalProperties'] !== 'boolean'
	) {
		problems.push(
			`${path}.additionalProperties must be a boolean in the supported subset.`,
		)
	}
	if ('items' in schema) {
		problems.push(
			...listJsonSchemaSubsetProblems(schema['items'], `${path}.items`),
		)
	}
	if ('enum' in schema) {
		const enumValues = schema['enum']
		if (!Array.isArray(enumValues) || enumValues.length === 0) {
			problems.push(`${path}.enum must be a non-empty array of values.`)
		}
	}
	for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
		if (keyword in schema && !isNonNegativeInteger(schema[keyword])) {
			problems.push(`${path}.${keyword} must be a non-negative integer.`)
		}
	}
	for (const keyword of ['minimum', 'maximum']) {
		if (
			keyword in schema &&
			(typeof schema[keyword] !== 'number' || !Number.isFinite(schema[keyword]))
		) {
			problems.push(`${path}.${keyword} must be a finite number.`)
		}
	}
	return problems
}

function matchesType(type: string, value: unknown): boolean {
	switch (type) {
		case 'object':
			return isRecord(value)
		case 'array':
			return Array.isArray(value)
		case 'string':
			return typeof value === 'string'
		case 'number':
			return typeof value === 'number' && Number.isFinite(value)
		case 'integer':
			return typeof value === 'number' && Number.isInteger(value)
		case 'boolean':
			return typeof value === 'boolean'
		case 'null':
			return value === null
		default:
			return false
	}
}

/**
 * Validate a JSON value against a subset schema. Callers must have checked
 * the schema with {@link listJsonSchemaSubsetProblems} first; unsupported
 * keywords are ignored here.
 */
export function listJsonSchemaSubsetValueErrors(
	schema: JsonSchemaSubset,
	value: unknown,
	path = 'payload',
): Array<string> {
	const errors: Array<string> = []
	const types = listSchemaTypes(schema)
	if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
		errors.push(`${path} must have type ${types.join(' | ')}.`)
		return errors
	}
	if ('const' in schema) {
		if (
			canonicalJsonStringify(value) !== canonicalJsonStringify(schema['const'])
		) {
			errors.push(
				`${path} must equal the const value ${canonicalJsonStringify(schema['const'])}.`,
			)
		}
	}
	if (Array.isArray(schema['enum'])) {
		const candidate = canonicalJsonStringify(value)
		if (
			!schema['enum'].some(
				(entry) => canonicalJsonStringify(entry) === candidate,
			)
		) {
			errors.push(
				`${path} must be one of ${schema['enum']
					.map((entry) => canonicalJsonStringify(entry))
					.join(', ')}.`,
			)
		}
	}
	if (typeof value === 'string') {
		const minLength = schema['minLength']
		if (isNonNegativeInteger(minLength) && value.length < minLength) {
			errors.push(`${path} must have at least ${minLength} characters.`)
		}
		const maxLength = schema['maxLength']
		if (isNonNegativeInteger(maxLength) && value.length > maxLength) {
			errors.push(`${path} must have at most ${maxLength} characters.`)
		}
	}
	if (typeof value === 'number') {
		const minimum = schema['minimum']
		if (typeof minimum === 'number' && value < minimum) {
			errors.push(`${path} must be >= ${minimum}.`)
		}
		const maximum = schema['maximum']
		if (typeof maximum === 'number' && value > maximum) {
			errors.push(`${path} must be <= ${maximum}.`)
		}
	}
	if (Array.isArray(value)) {
		const minItems = schema['minItems']
		if (isNonNegativeInteger(minItems) && value.length < minItems) {
			errors.push(`${path} must have at least ${minItems} items.`)
		}
		const maxItems = schema['maxItems']
		if (isNonNegativeInteger(maxItems) && value.length > maxItems) {
			errors.push(`${path} must have at most ${maxItems} items.`)
		}
		const items = schema['items']
		if (isRecord(items)) {
			for (const [index, entry] of value.entries()) {
				errors.push(
					...listJsonSchemaSubsetValueErrors(items, entry, `${path}[${index}]`),
				)
			}
		}
	}
	if (isRecord(value)) {
		const required = schema['required']
		if (Array.isArray(required)) {
			for (const key of required) {
				if (typeof key === 'string' && !(key in value)) {
					errors.push(`${path} is missing required property "${key}".`)
				}
			}
		}
		// Missing `properties` means an empty declared set, so
		// `additionalProperties: false` rejects every key (standard JSON
		// Schema behavior).
		const properties = isRecord(schema['properties'])
			? schema['properties']
			: {}
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value) || !isRecord(propertySchema)) continue
			errors.push(
				...listJsonSchemaSubsetValueErrors(
					propertySchema,
					value[key],
					`${path}.${key}`,
				),
			)
		}
		if (schema['additionalProperties'] === false) {
			for (const key of Object.keys(value)) {
				if (!(key in properties)) {
					errors.push(`${path} has unexpected property "${key}".`)
				}
			}
		}
	}
	return errors
}
