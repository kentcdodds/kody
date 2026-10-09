import { expect, test } from 'vitest'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import { isOrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { buildOpenApiDocument, resolveApiOperation } from './document.ts'
import {
	apiOperationUsesQueryInputs,
	apiOperations,
	getApiOperationPathParams,
	matchApiRoute,
} from './operations.ts'

/**
 * Capabilities that are deliberately not on the Open API. Anything else in
 * an included domain must have an operation, so a new capability cannot
 * silently skip the API.
 */
const excludedDomains = new Set(['admin', 'apps', 'coding', 'values'])
const excludedCapabilities = new Set([
	'execute',
	'metaListCapabilities',
	'packageAppFetch',
	'packageSubscriptionDispatch',
	'webhookSyntheticDispatch',
	'communitySetFeatured',
])

function schemaTypes(schema: unknown): Array<string> {
	if (!isRecord(schema)) return []
	const type = schema['type']
	const own =
		typeof type === 'string'
			? [type]
			: Array.isArray(type)
				? type.filter((entry): entry is string => typeof entry === 'string')
				: []
	const variants = [schema['anyOf'], schema['oneOf']].flatMap((value) =>
		Array.isArray(value) ? value.flatMap(schemaTypes) : [],
	)
	const enumTypes = Array.isArray(schema['enum'])
		? schema['enum'].map((value) => (value === null ? 'null' : typeof value))
		: []
	const constType =
		'const' in schema
			? [schema['const'] === null ? 'null' : typeof schema['const']]
			: []
	return [...own, ...variants, ...enumTypes, ...constType]
}

const scalarTypes = new Set(['string', 'number', 'integer', 'boolean', 'null'])

function isQueryEncodable(schema: unknown) {
	const types = schemaTypes(schema)
	if (types.length === 0) return false
	return types.every((type) => {
		if (scalarTypes.has(type)) return true
		if (type !== 'array' || !isRecord(schema)) return false
		const items = schema['items']
		const itemTypes = schemaTypes(items)
		return (
			itemTypes.length > 0 && itemTypes.every((entry) => scalarTypes.has(entry))
		)
	})
}

test('operation ids and method+path pairs are unique', () => {
	const ids = apiOperations.map((operation) => operation.operationId)
	expect(new Set(ids).size).toBe(ids.length)
	const routes = apiOperations.map(
		(operation) => `${operation.method} ${operation.path}`,
	)
	expect(new Set(routes).size).toBe(routes.length)
	for (const operation of apiOperations) {
		expect(operation.path.startsWith('/v1/')).toBe(true)
	}
})

test('every capability operation is a public, non-admin capability with matching inputs', async () => {
	const registry = await getStaticRegistry()
	const problems: Array<string> = []
	for (const operation of apiOperations) {
		const resolved = resolveApiOperation(operation, registry)
		if (operation.kind === 'capability') {
			const capability = registry.capabilityMap[operation.operationId]!
			if (excludedDomains.has(capability.domain)) {
				problems.push(`${operation.operationId}: excluded domain`)
			}
			if (capability.requiredRole || capability.requiredPermission) {
				problems.push(`${operation.operationId}: requires a role`)
			}
		}
		if (operation.method === 'GET' && !resolved.readOnly) {
			problems.push(`${operation.operationId}: GET must be read-only`)
		}
		const properties = isRecord(resolved.inputSchema['properties'])
			? resolved.inputSchema['properties']
			: {}
		const pathParams = getApiOperationPathParams(operation.path)
		for (const name of pathParams) {
			if (!(name in properties)) {
				problems.push(
					`${operation.operationId}: path param ${name} not an input`,
				)
			}
		}
		if (!apiOperationUsesQueryInputs(operation.method)) continue
		const omitted =
			operation.kind === 'capability' ? (operation.omitInputs ?? []) : []
		for (const [name, schema] of Object.entries(properties)) {
			if (pathParams.includes(name) || omitted.includes(name)) continue
			if (!isQueryEncodable(schema)) {
				problems.push(
					`${operation.operationId}: input ${name} cannot be a query param`,
				)
			}
		}
		const required = Array.isArray(resolved.inputSchema['required'])
			? (resolved.inputSchema['required'] as Array<string>)
			: []
		for (const name of omitted) {
			if (required.includes(name)) {
				problems.push(
					`${operation.operationId}: omitted input ${name} is required`,
				)
			}
		}
	}
	expect(problems).toEqual([])
})

test('every public capability in an API domain has an operation', async () => {
	const registry = await getStaticRegistry()
	const covered = new Set(
		apiOperations.map((operation) => operation.operationId),
	)
	const missing = registry.capabilityList
		.filter(
			(capability) =>
				!excludedDomains.has(capability.domain) &&
				!excludedCapabilities.has(capability.name) &&
				!capability.requiredRole &&
				!capability.requiredPermission,
		)
		.map((capability) => capability.name)
		.filter((name) => !covered.has(name))
	expect(missing).toEqual([])
})

test('every operation routes to itself, and static segments beat params', () => {
	for (const operation of apiOperations) {
		const path = operation.path.replace(/\{([^}]+)\}/g, 'sample-$1')
		const match = matchApiRoute(operation.method, path)
		expect(match.kind === 'match' && match.operation.operationId).toBe(
			operation.operationId,
		)
	}
	const current = matchApiRoute('GET', '/v1/tokens/current')
	expect(current.kind === 'match' && current.operation.operationId).toBe(
		'tokenGetCurrent',
	)
	const byId = matchApiRoute('GET', '/v1/tokens/abc')
	expect(byId).toMatchObject({
		kind: 'match',
		pathParams: { token_id: 'abc' },
	})
	const encoded = matchApiRoute('PUT', '/v1/secrets/user/my%20secret')
	expect(encoded).toMatchObject({
		kind: 'match',
		pathParams: { scope: 'user', name: 'my secret' },
	})
	expect(matchApiRoute('PATCH', '/v1/tokens')).toEqual({
		kind: 'method_not_allowed',
		allow: ['GET', 'POST'],
	})
	expect(matchApiRoute('GET', '/v1/nope')).toEqual({ kind: 'not_found' })
})

test('the OpenAPI document covers every operation with resolvable refs', async () => {
	const document = await buildOpenApiDocument({
		serverUrl: 'https://api.kody.codes',
	})
	expect(document.openapi).toBe('3.1.0')
	expect(document.servers).toEqual([{ url: 'https://api.kody.codes' }])
	expect(document.externalDocs).toEqual({
		description: 'Interactive Kody API docs (Scalar)',
		url: 'https://api-docs.kody.codes',
	})
	expect(String(document.info['description'])).toContain(
		'https://api-docs.kody.codes',
	)

	const operationIds = Object.values(document.paths).flatMap((pathItem) =>
		Object.values(pathItem).map((operation) => operation.operationId),
	)
	expect(operationIds.sort()).toEqual(
		apiOperations.map((operation) => operation.operationId).sort(),
	)

	const serialized = JSON.stringify(document)
	expect(serialized).not.toContain('"$schema"')
	expect(serialized).not.toContain('#/$defs/')
	const components = document.components as Record<
		string,
		Record<string, unknown>
	>
	const danglingRefs = [...serialized.matchAll(/"\$ref":"([^"]+)"/g)]
		.map(([, ref]) => ref!)
		.filter((ref) => {
			const [, section, name] = /^#\/components\/(\w+)\/(.+)$/.exec(ref) ?? []
			return !(section && name && components[section]?.[name])
		})
	expect(danglingRefs).toEqual([])

	const pathParamMismatches: Array<string> = []
	const missingPermissions: Array<string> = []
	for (const [path, pathItem] of Object.entries(document.paths)) {
		for (const operation of Object.values(pathItem)) {
			const declared = (operation.parameters ?? [])
				.filter((parameter) => parameter.in === 'path')
				.map((parameter) => parameter.name)
				.sort()
			const expected = getApiOperationPathParams(path).sort()
			if (declared.join() !== expected.join()) {
				pathParamMismatches.push(String(operation.operationId))
			}
			expect(operation).not.toHaveProperty('x-kody-scope')
			const permission = operation['x-kody-permission']
			if (permission !== 'none' && !isOrgPermission(permission)) {
				missingPermissions.push(String(operation.operationId))
			}
		}
	}
	expect(pathParamMismatches).toEqual([])
	expect(missingPermissions).toEqual([])
	expect(
		document.paths['/v1/packages/{package_id}']?.['get']?.['x-kody-permission'],
	).toBe('package:read')
	expect(
		document.paths['/v1/capability-proxy/call']?.['post']?.[
			'x-kody-permission'
		],
	).toBe('org:execute')

	const tokenCreate = document.paths['/v1/tokens']?.['post']
	expect(tokenCreate?.['x-kody-permission']).toBe('none')
	expect(tokenCreate?.requestBody?.required).toBe(true)
	expect(document.paths['/v1/tokens']?.['get']?.['x-kody-permission']).toBe(
		'token:read',
	)
	expect(
		document.paths['/v1/tokens/{token_id}']?.['get']?.['x-kody-permission'],
	).toBe('token:read')
	expect(
		document.paths['/v1/tokens/{token_id}']?.['delete']?.['x-kody-permission'],
	).toBe('token:delete')
	expect(
		document.paths['/v1/tokens/{token_id}/rotate']?.['post']?.[
			'x-kody-permission'
		],
	).toBe('token:delete')
	const secretSet = document.paths['/v1/secrets/{scope}/{name}']?.['put']
	const secretBody = secretSet?.requestBody?.content['application/json'].schema
	expect(
		Object.keys((secretBody?.['properties'] as object) ?? {}),
	).not.toContain('name')
	expect(
		document.paths['/v1/secrets/lock']?.['post']?.['x-kody-permission'],
	).toBe('secret:use')
	expect(document.paths['/v1/search']?.['get']?.['x-kody-permission']).toBe(
		'search:read',
	)
})
