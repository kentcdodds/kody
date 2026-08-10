import { isRecord } from '@kody-internal/shared/is-record.ts'
import { parse as parseYaml } from 'yaml'
import {
	type OpenApiHttpMethod,
	type OpenApiOperation,
	type OpenApiParameter,
	type OpenApiRequestBody,
	type OpenApiSecurityScheme,
	type OpenApiServer,
	type ParsedOpenApiSpec,
} from './spec-types.ts'

const SUMMARY_MAX_CHARS = 120
const DESCRIPTION_MAX_CHARS = 300
const MAX_OPERATIONS = 2000
const MAX_WARNINGS = 50
const MAX_REF_DEPTH = 10
const SCHEMA_MAX_DEPTH = 6
const SCHEMA_MAX_NODES = 200

const HTTP_METHODS = [
	'get',
	'put',
	'post',
	'delete',
	'options',
	'head',
	'patch',
	'trace',
] as const satisfies ReadonlyArray<OpenApiHttpMethod>

const OAUTH_FLOW_KEYS = [
	'authorizationCode',
	'clientCredentials',
	'implicit',
	'password',
] as const

function asString(value: unknown): string | null {
	return typeof value === 'string' ? value : null
}

function truncateText(value: string | null, maxChars: number): string | null {
	if (value == null) return null
	if (value.length <= maxChars) return value
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

function addWarning(warnings: Array<string>, message: string) {
	if (warnings.includes(message)) return
	if (warnings.length >= MAX_WARNINGS) {
		const overflow = 'additional warnings omitted'
		if (!warnings.includes(overflow)) {
			warnings.push(overflow)
		}
		return
	}
	warnings.push(message)
}

function parseDocument(rawText: string): unknown {
	try {
		return JSON.parse(rawText)
	} catch {
		try {
			return parseYaml(rawText)
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause)
			throw new Error(
				`OpenAPI spec is neither valid JSON nor YAML (${message})`,
			)
		}
	}
}

function resolvePointer(
	root: Record<string, unknown>,
	pointer: string,
): unknown {
	if (!pointer.startsWith('#/')) {
		return undefined
	}
	const parts = pointer
		.slice(2)
		.split('/')
		.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
	let current: unknown = root
	for (const part of parts) {
		if (!isRecord(current) && !Array.isArray(current)) {
			return undefined
		}
		if (Array.isArray(current)) {
			const index = Number(part)
			if (!Number.isInteger(index) || index < 0 || index >= current.length) {
				return undefined
			}
			current = current[index]
			continue
		}
		if (!(part in current)) {
			return undefined
		}
		current = current[part]
	}
	return current
}

function resolveLocalRef(
	root: Record<string, unknown>,
	value: unknown,
	warnings: Array<string>,
	visited: Set<string>,
	depth: number,
): unknown {
	if (depth > MAX_REF_DEPTH) {
		addWarning(
			warnings,
			`local $ref resolution stopped at depth ${MAX_REF_DEPTH}`,
		)
		return null
	}
	if (!isRecord(value)) {
		return value
	}
	const ref = asString(value.$ref)
	if (ref == null) {
		return value
	}
	if (!ref.startsWith('#/')) {
		addWarning(
			warnings,
			`skipped non-local $ref "${ref}" (remote/file refs are not resolved)`,
		)
		return null
	}
	if (visited.has(ref)) {
		addWarning(warnings, `cyclic local $ref detected at "${ref}"`)
		return null
	}
	const target = resolvePointer(root, ref)
	if (target === undefined) {
		addWarning(warnings, `unresolvable local $ref "${ref}"`)
		return null
	}
	visited.add(ref)
	const resolved = resolveLocalRef(root, target, warnings, visited, depth + 1)
	visited.delete(ref)
	if (isRecord(resolved) && Object.keys(value).length > 1) {
		const { $ref: _ref, ...siblings } = value
		return { ...resolved, ...siblings }
	}
	return resolved
}

function boundSchema(
	root: Record<string, unknown>,
	value: unknown,
	warnings: Array<string>,
	depth = 0,
	state = { nodes: 0, truncated: false },
): Record<string, unknown> | null {
	if (value == null) return null

	function visit(node: unknown, currentDepth: number): unknown {
		if (state.truncated) return {}
		if (currentDepth > SCHEMA_MAX_DEPTH || state.nodes >= SCHEMA_MAX_NODES) {
			if (!state.truncated) {
				state.truncated = true
				addWarning(
					warnings,
					`schema truncated (max depth ${SCHEMA_MAX_DEPTH}, max nodes ${SCHEMA_MAX_NODES})`,
				)
			}
			return {}
		}

		const resolved = resolveLocalRef(root, node, warnings, new Set(), 0)
		if (resolved == null || typeof resolved !== 'object') {
			return resolved
		}

		state.nodes += 1
		if (Array.isArray(resolved)) {
			return resolved.map((entry) => visit(entry, currentDepth + 1))
		}

		const result: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(resolved)) {
			if (key.startsWith('x-')) continue
			result[key] = visit(entry, currentDepth + 1)
		}
		return result
	}

	const bounded = visit(value, depth)
	return isRecord(bounded) ? bounded : null
}

function resolveAndBoundSchema(
	root: Record<string, unknown>,
	value: unknown,
	warnings: Array<string>,
): Record<string, unknown> | null {
	return boundSchema(root, value, warnings)
}

export function deriveOperationSlug(
	operationId: string | null,
	method: OpenApiHttpMethod,
	path: string,
): string {
	const source = operationId?.trim() || `${method}_${path}`
	const slug = source
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
	return slug.length > 0 ? slug : 'operation'
}

function dedupeSlug(base: string, used: Set<string>): string {
	if (!used.has(base)) {
		used.add(base)
		return base
	}
	let suffix = 2
	while (used.has(`${base}_${suffix}`)) {
		suffix += 1
	}
	const slug = `${base}_${suffix}`
	used.add(slug)
	return slug
}

function substituteServerUrl(
	urlTemplate: string,
	variables: Record<string, unknown> | undefined,
): string {
	return urlTemplate.replace(/\{([^}]+)\}/g, (match, name: string) => {
		const variable = variables?.[name]
		if (!isRecord(variable)) return match
		const defaultValue = asString(variable.default)
		return defaultValue ?? match
	})
}

function parseServers(
	rawServers: unknown,
	warnings: Array<string>,
): Array<OpenApiServer> {
	if (!Array.isArray(rawServers)) return []
	const servers: Array<OpenApiServer> = []
	for (const entry of rawServers) {
		if (!isRecord(entry)) continue
		const url = asString(entry.url)
		if (url == null || url.length === 0) {
			addWarning(warnings, 'skipped server entry without a url')
			continue
		}
		const variables = isRecord(entry.variables) ? entry.variables : undefined
		servers.push({
			url: substituteServerUrl(url, variables),
			description: truncateText(
				asString(entry.description),
				DESCRIPTION_MAX_CHARS,
			),
		})
	}
	return servers
}

function parseSecuritySchemeNames(security: unknown): Array<string> {
	if (!Array.isArray(security)) return []
	const names: Array<string> = []
	for (const requirement of security) {
		if (!isRecord(requirement)) continue
		for (const name of Object.keys(requirement)) {
			if (!names.includes(name)) names.push(name)
		}
	}
	return names
}

function parseSecuritySchemes(
	components: Record<string, unknown> | undefined,
	warnings: Array<string>,
): Array<OpenApiSecurityScheme> {
	const rawSchemes = components?.securitySchemes
	if (!isRecord(rawSchemes)) return []

	const schemes: Array<OpenApiSecurityScheme> = []
	for (const [name, rawScheme] of Object.entries(rawSchemes)) {
		if (!isRecord(rawScheme)) {
			addWarning(warnings, `skipped invalid security scheme "${name}"`)
			continue
		}
		const typeRaw = asString(rawScheme.type)
		const type: OpenApiSecurityScheme['type'] =
			typeRaw === 'apiKey' ||
			typeRaw === 'http' ||
			typeRaw === 'oauth2' ||
			typeRaw === 'openIdConnect' ||
			typeRaw === 'mutualTLS'
				? typeRaw
				: 'unknown'

		const inRaw = asString(rawScheme.in)
		const inLocation: OpenApiSecurityScheme['in'] =
			inRaw === 'header' || inRaw === 'query' || inRaw === 'cookie'
				? inRaw
				: null

		const flows: OpenApiSecurityScheme['flows'] = []
		let authorizationUrl: string | null = null
		let tokenUrl: string | null = null
		const scopes = new Set<string>()

		if (type === 'oauth2' && isRecord(rawScheme.flows)) {
			for (const flowKey of OAUTH_FLOW_KEYS) {
				const flow = rawScheme.flows[flowKey]
				if (!isRecord(flow)) continue
				flows.push(flowKey)
				authorizationUrl = authorizationUrl ?? asString(flow.authorizationUrl)
				tokenUrl = tokenUrl ?? asString(flow.tokenUrl)
				if (isRecord(flow.scopes)) {
					for (const scope of Object.keys(flow.scopes)) {
						scopes.add(scope)
					}
				}
			}
		}

		schemes.push({
			name,
			type,
			description: truncateText(
				asString(rawScheme.description),
				DESCRIPTION_MAX_CHARS,
			),
			in: type === 'apiKey' ? inLocation : null,
			parameterName: type === 'apiKey' ? asString(rawScheme.name) : null,
			scheme: type === 'http' ? asString(rawScheme.scheme) : null,
			flows,
			authorizationUrl,
			tokenUrl,
			scopes: [...scopes],
		})
	}
	return schemes
}

function parseParameter(
	root: Record<string, unknown>,
	raw: unknown,
	warnings: Array<string>,
): OpenApiParameter | null {
	const resolved = resolveLocalRef(root, raw, warnings, new Set(), 0)
	if (!isRecord(resolved)) return null
	const name = asString(resolved.name)
	const locationRaw = asString(resolved.in)
	if (name == null || locationRaw == null) return null
	if (
		locationRaw !== 'path' &&
		locationRaw !== 'query' &&
		locationRaw !== 'header' &&
		locationRaw !== 'cookie'
	) {
		return null
	}
	return {
		name,
		location: locationRaw,
		required: resolved.required === true || locationRaw === 'path',
		description: truncateText(
			asString(resolved.description),
			DESCRIPTION_MAX_CHARS,
		),
		schema: resolveAndBoundSchema(root, resolved.schema, warnings),
	}
}

function parseRequestBody(
	root: Record<string, unknown>,
	raw: unknown,
	warnings: Array<string>,
): OpenApiRequestBody | null {
	const resolved = resolveLocalRef(root, raw, warnings, new Set(), 0)
	if (!isRecord(resolved)) return null
	const content = isRecord(resolved.content) ? resolved.content : null
	if (content == null) {
		return {
			required: resolved.required === true,
			contentType: null,
			schema: null,
		}
	}

	const contentTypes = Object.keys(content)
	const preferred =
		contentTypes.find((type) => type === 'application/json') ??
		contentTypes.find((type) => type.startsWith('application/json')) ??
		contentTypes[0] ??
		null
	const media = preferred != null ? content[preferred] : null
	const schema =
		isRecord(media) && media.schema != null
			? resolveAndBoundSchema(root, media.schema, warnings)
			: null

	return {
		required: resolved.required === true,
		contentType: preferred,
		schema,
	}
}

function parseOperations(
	root: Record<string, unknown>,
	paths: Record<string, unknown>,
	warnings: Array<string>,
): Array<OpenApiOperation> {
	const operations: Array<OpenApiOperation> = []
	const usedSlugs = new Set<string>()
	let truncated = false

	for (const [path, pathItemRaw] of Object.entries(paths)) {
		if (truncated) break
		const pathItem = resolveLocalRef(root, pathItemRaw, warnings, new Set(), 0)
		if (!isRecord(pathItem)) continue

		const sharedParameters: Array<OpenApiParameter> = []
		if (Array.isArray(pathItem.parameters)) {
			for (const parameter of pathItem.parameters) {
				const parsed = parseParameter(root, parameter, warnings)
				if (parsed) sharedParameters.push(parsed)
			}
		}

		for (const method of HTTP_METHODS) {
			if (truncated) break
			const operationRaw = pathItem[method]
			if (!isRecord(operationRaw)) continue

			if (operations.length >= MAX_OPERATIONS) {
				truncated = true
				addWarning(
					warnings,
					`operation count exceeded ${MAX_OPERATIONS}; additional operations omitted`,
				)
				break
			}

			const operationId = asString(operationRaw.operationId)
			const baseSlug = deriveOperationSlug(operationId, method, path)
			const slug = dedupeSlug(baseSlug, usedSlugs)

			const parameters = [...sharedParameters]
			if (Array.isArray(operationRaw.parameters)) {
				for (const parameter of operationRaw.parameters) {
					const parsed = parseParameter(root, parameter, warnings)
					if (parsed) parameters.push(parsed)
				}
			}

			const tags = Array.isArray(operationRaw.tags)
				? operationRaw.tags.filter(
						(tag): tag is string => typeof tag === 'string',
					)
				: []

			operations.push({
				operationId,
				slug,
				method,
				path,
				summary: truncateText(
					asString(operationRaw.summary),
					SUMMARY_MAX_CHARS,
				),
				description: truncateText(
					asString(operationRaw.description),
					DESCRIPTION_MAX_CHARS,
				),
				tags,
				deprecated: operationRaw.deprecated === true,
				parameters,
				requestBody:
					operationRaw.requestBody != null
						? parseRequestBody(root, operationRaw.requestBody, warnings)
						: null,
				securitySchemeNames: parseSecuritySchemeNames(operationRaw.security),
			})
		}
	}

	return operations
}

export function parseOpenApiSpec(rawText: string): ParsedOpenApiSpec {
	const document = parseDocument(rawText)
	if (!isRecord(document)) {
		throw new Error('OpenAPI spec must be a JSON/YAML object')
	}

	const swagger = asString(document.swagger)
	if (swagger != null) {
		throw new Error(
			`Swagger ${swagger} is not supported; provide an OpenAPI 3.x document`,
		)
	}

	const openapiVersion = asString(document.openapi)
	if (openapiVersion == null || !openapiVersion.startsWith('3.')) {
		throw new Error(
			`OpenAPI 3.x required (got openapi=${openapiVersion ?? 'missing'})`,
		)
	}

	const warnings: Array<string> = []
	const info = isRecord(document.info) ? document.info : {}
	const components = isRecord(document.components)
		? document.components
		: undefined
	const paths = isRecord(document.paths) ? document.paths : {}

	return {
		openapiVersion,
		title: asString(info.title),
		version: asString(info.version),
		description: truncateText(
			asString(info.description),
			DESCRIPTION_MAX_CHARS,
		),
		servers: parseServers(document.servers, warnings),
		operations: parseOperations(document, paths, warnings),
		securitySchemes: parseSecuritySchemes(components, warnings),
		defaultSecuritySchemeNames: parseSecuritySchemeNames(document.security),
		warnings,
	}
}
