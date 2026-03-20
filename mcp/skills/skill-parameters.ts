import * as acorn from 'acorn'
import { z } from 'zod'

const skillParameterTypes = ['string', 'number', 'boolean', 'json'] as const

export type SkillParameterType = (typeof skillParameterTypes)[number]

export type SkillParameterInput = {
	name: string
	description: string
	type: SkillParameterType
	required?: boolean | undefined
	default?: unknown
}

export type SkillParameterDefinition = {
	name: string
	description: string
	type: SkillParameterType
	required: boolean
	default?: unknown
}

export const skillParameterSchema = z.object({
	name: z.string().min(1).describe('Parameter name passed in params.'),
	description: z
		.string()
		.min(1)
		.describe('What this parameter controls for the skill.'),
	type: z
		.enum(skillParameterTypes)
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

const skillParametersSchema = z.array(skillParameterSchema)

export function normalizeSkillParameters(
	input: Array<SkillParameterInput> | undefined,
): Array<SkillParameterDefinition> | null {
	if (!input || input.length === 0) return null
	const seen = new Set<string>()
	const out: Array<SkillParameterDefinition> = []
	for (const param of input) {
		const name = param.name.trim()
		if (!name) {
			throw new Error('Skill parameter name cannot be empty.')
		}
		if (seen.has(name)) {
			throw new Error(`Duplicate skill parameter name: ${name}.`)
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

export function parseSkillParameters(
	raw: string | null,
): Array<SkillParameterDefinition> | null {
	if (raw == null) return null
	try {
		const parsed = JSON.parse(raw) as unknown
		const result = skillParametersSchema.safeParse(parsed)
		if (!result.success) return null
		return normalizeSkillParameters(result.data)
	} catch {
		return null
	}
}

export function applySkillParameters(input: {
	definitions: Array<SkillParameterDefinition> | null
	values: Record<string, unknown> | undefined
}): Record<string, unknown> {
	if (!input.definitions || input.definitions.length === 0) {
		const fallback = input.values ?? {}
		assertJsonSerializable(fallback, 'skill params')
		return fallback
	}
	const values = input.values ?? {}
	const definedNames = new Set(input.definitions.map((def) => def.name))
	const unknown = Object.keys(values).filter((key) => !definedNames.has(key))
	if (unknown.length > 0) {
		throw new Error(`Unknown skill parameter(s): ${unknown.join(', ')}.`)
	}
	const resolved: Record<string, unknown> = {}
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
			throw new Error(`Missing required skill parameter: ${def.name}.`)
		}
	}
	assertJsonSerializable(resolved, 'skill params')
	return resolved
}

export async function buildParameterizedSkillCode(
	code: string,
	params: Record<string, unknown>,
): Promise<string> {
	const normalized = normalizeSkillCode(code)
	const paramsJson = JSON.stringify(params)
	if (paramsJson == null) {
		throw new Error('Skill parameters must be JSON-serializable.')
	}
	return `async () => {
  const params = ${paramsJson};
  const skill = (${normalized});
  return await skill(params);
}`
}

function stripCodeFences(code: string): string {
	const match = code.match(
		/^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/,
	)
	return match ? match[1] : code
}

function normalizeSkillCode(code: string): string {
	const trimmed = stripCodeFences(code.trim())
	if (!trimmed.trim()) return 'async () => {}'
	const source = trimmed.trim()
	try {
		const ast = acorn.parse(source, {
			ecmaVersion: 'latest',
			sourceType: 'module',
		})
		if (
			ast.body.length === 1 &&
			ast.body[0].type === 'ExpressionStatement'
		) {
			const statement = ast.body[0]
			if (statement.expression.type === 'ArrowFunctionExpression') {
				return source
			}
		}
		if (
			ast.body.length === 1 &&
			ast.body[0].type === 'ExportDefaultDeclaration'
		) {
			const decl = ast.body[0].declaration
			const inner = source.slice(decl.start, decl.end)
			if (decl.type === 'FunctionDeclaration' && !decl.id) {
				return `async () => {\nreturn (${inner})(params);\n}`
			}
			if (decl.type === 'ClassDeclaration' && !decl.id) {
				return `async () => {\nreturn (${inner});\n}`
			}
			return normalizeSkillCode(inner)
		}
		if (ast.body.length === 1 && ast.body[0].type === 'FunctionDeclaration') {
			return `async () => {\n${source}\nreturn ${ast.body[0].id?.name ?? 'fn'}(params);\n}`
		}
		const last = ast.body[ast.body.length - 1]
		if (last?.type === 'ExpressionStatement') {
			return `async () => {\n${source.slice(0, last.start)}return (${source.slice(last.expression.start, last.expression.end)})\n}`
		}
		return `async () => {\n${source}\n}`
	} catch {
		return `async () => {\n${source}\n}`
	}
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
	type: SkillParameterType,
	label: string,
) {
	if (value === undefined) {
		throw new Error(`Skill parameter "${label}" must not be undefined.`)
	}
	if (type === 'json') return
	if (type === 'string') {
		if (typeof value !== 'string') {
			throw new Error(`Skill parameter "${label}" must be a string.`)
		}
		return
	}
	if (type === 'number') {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new Error(`Skill parameter "${label}" must be a number.`)
		}
		return
	}
	if (type === 'boolean') {
		if (typeof value !== 'boolean') {
			throw new Error(`Skill parameter "${label}" must be a boolean.`)
		}
	}
}
