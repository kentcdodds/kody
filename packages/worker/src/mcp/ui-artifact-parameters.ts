import { z } from 'zod'

const uiArtifactParameterTypes = ['string', 'number', 'boolean', 'json'] as const
const reservedParameterNames = new Set([
	'__proto__',
	'constructor',
	'prototype',
	'__defineGetter__',
	'__defineSetter__',
	'__lookupGetter__',
	'__lookupSetter__',
])

export type UiArtifactParameterType = (typeof uiArtifactParameterTypes)[number]

export type UiArtifactParameterInput = {
	name: string
	description: string
	type: UiArtifactParameterType
	required?: boolean | undefined
	default?: unknown
}

export type UiArtifactParameterDefinition = {
	name: string
	description: string
	type: UiArtifactParameterType
	required: boolean
	default?: unknown
}

export const uiArtifactParameterSchema = z.object({
	name: z.string().min(1).describe('Parameter name available on window.kodyWidget.params.'),
	description: z
		.string()
		.min(1)
		.describe('What this parameter controls for the saved app.'),
	type: z
		.enum(uiArtifactParameterTypes)
		.describe('Expected parameter type for runtime validation.'),
	required: z
		.boolean()
		.optional()
		.describe('Whether the caller must provide a value for this parameter.'),
	default: z
		.unknown()
		.optional()
		.describe('Default value used when the caller omits this parameter.'),
})

const uiArtifactParametersSchema = z.array(uiArtifactParameterSchema)

export function normalizeUiArtifactParameters(
	input: Array<UiArtifactParameterInput> | undefined,
): Array<UiArtifactParameterDefinition> | null {
	if (!input || input.length === 0) return null
	const seen = new Set<string>()
	const out: Array<UiArtifactParameterDefinition> = []
	for (const param of input) {
		const name = param.name.trim()
		if (!name) {
			throw new Error('Saved app parameter name cannot be empty.')
		}
		if (reservedParameterNames.has(name)) {
			throw new Error(`Saved app parameter name "${name}" is not allowed.`)
		}
		if (seen.has(name)) {
			throw new Error(`Duplicate saved app parameter name: ${name}.`)
		}
		seen.add(name)
		if (param.default !== undefined) {
			assertParameterValueType(param.default, param.type, `default for ${name}`)
			assertJsonSerializable(param.default, `default for ${name}`)
		}
		out.push({
			name,
			description: param.description,
			type: param.type,
			required: param.required ?? false,
			...(param.default !== undefined ? { default: param.default } : {}),
		})
	}
	return out
}

export function parseUiArtifactParameters(
	raw: string | null,
): Array<UiArtifactParameterDefinition> | null {
	if (raw == null) return null
	try {
		const parsed = JSON.parse(raw) as unknown
		const result = uiArtifactParametersSchema.safeParse(parsed)
		if (!result.success) return null
		return normalizeUiArtifactParameters(result.data)
	} catch {
		return null
	}
}

export function applyUiArtifactParameters(input: {
	definitions: Array<UiArtifactParameterDefinition> | null
	values: Record<string, unknown> | undefined
}): Record<string, unknown> {
	if (!input.definitions || input.definitions.length === 0) {
		const fallback = input.values ?? {}
		assertJsonSerializable(fallback, 'saved app params')
		return fallback
	}
	const values = input.values ?? {}
	const definedNames = new Set(input.definitions.map((def) => def.name))
	const unknown = Object.keys(values).filter((key) => !definedNames.has(key))
	if (unknown.length > 0) {
		throw new Error(`Unknown saved app parameter(s): ${unknown.join(', ')}.`)
	}
	const resolved: Record<string, unknown> = Object.create(null)
	for (const def of input.definitions) {
		if (Object.prototype.hasOwnProperty.call(values, def.name)) {
			const value = values[def.name]
			assertParameterValueType(value, def.type, def.name)
			resolved[def.name] = value
			continue
		}
		if (def.default !== undefined) {
			resolved[def.name] = def.default
			continue
		}
		if (def.required) {
			throw new Error(`Missing required saved app parameter: ${def.name}.`)
		}
	}
	assertJsonSerializable(resolved, 'saved app params')
	return resolved
}

function assertJsonSerializable(value: unknown, label: string) {
	try {
		const json = JSON.stringify(value)
		if (json == null) {
			throw new Error(`${label} must be JSON-serializable.`)
		}
	} catch {
		throw new Error(`${label} must be JSON-serializable.`)
	}
}

function assertParameterValueType(
	value: unknown,
	type: UiArtifactParameterType,
	label: string,
) {
	if (value === undefined) {
		throw new Error(`Saved app parameter "${label}" must not be undefined.`)
	}
	if (type === 'json') return
	if (type === 'string') {
		if (typeof value !== 'string') {
			throw new Error(`Saved app parameter "${label}" must be a string.`)
		}
		return
	}
	if (type === 'number') {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new Error(`Saved app parameter "${label}" must be a number.`)
		}
		return
	}
	if (type === 'boolean' && typeof value !== 'boolean') {
		throw new Error(`Saved app parameter "${label}" must be a boolean.`)
	}
}
