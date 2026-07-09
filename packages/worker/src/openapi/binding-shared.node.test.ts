import { expect, test } from 'vitest'
import {
	assertOpenApiBindingWithinSizeLimit,
	buildOpenApiBindingValueName,
	maxOpenApiBindingOperations,
	openApiBindingNamePattern,
	openApiBindingSaveInputSchema,
	parseOpenApiBindingValueName,
	resolveOpenApiSelection,
	type OpenApiBinding,
} from './binding-shared.ts'
import { type OpenApiOperation } from './spec-types.ts'

function op(
	overrides: Partial<OpenApiOperation> &
		Pick<OpenApiOperation, 'slug' | 'method' | 'path'>,
): OpenApiOperation {
	return {
		operationId: overrides.operationId ?? overrides.slug,
		summary: overrides.summary ?? null,
		description: overrides.description ?? null,
		tags: overrides.tags ?? [],
		deprecated: overrides.deprecated ?? false,
		parameters: overrides.parameters ?? [],
		requestBody: overrides.requestBody ?? null,
		securitySchemeNames: overrides.securitySchemeNames ?? [],
		...overrides,
	}
}

test('binding name regex and value-name helpers', () => {
	expect(openApiBindingNamePattern.test('github')).toBe(true)
	expect(openApiBindingNamePattern.test('gh_api-1')).toBe(true)
	expect(openApiBindingNamePattern.test('Github')).toBe(false)
	expect(openApiBindingNamePattern.test('-bad')).toBe(false)
	expect(openApiBindingNamePattern.test('a'.repeat(65))).toBe(false)

	expect(buildOpenApiBindingValueName('github')).toBe('_openapi:github')
	expect(parseOpenApiBindingValueName('_openapi:github')).toBe('github')
	expect(parseOpenApiBindingValueName('_integration:github')).toBeNull()
	expect(parseOpenApiBindingValueName('_openapi:')).toBeNull()
})

test('save input schema requires at least one selector and https urls', () => {
	expect(() =>
		openApiBindingSaveInputSchema.parse({
			name: 'widgets',
			specUrl: 'https://specs.example/openapi.json',
			apiBaseUrl: 'https://api.example',
			auth: { kind: 'none' },
			selection: {},
		}),
	).toThrow(/at least one/)

	expect(() =>
		openApiBindingSaveInputSchema.parse({
			name: 'widgets',
			specUrl: 'http://specs.example/openapi.json',
			apiBaseUrl: 'https://api.example',
			auth: { kind: 'none' },
			selection: { tags: ['widgets'] },
		}),
	).toThrow(/https/)

	const parsed = openApiBindingSaveInputSchema.parse({
		name: 'widgets',
		specUrl: 'https://specs.example/openapi.json',
		apiBaseUrl: 'https://api.example/',
		auth: { kind: 'bearerSecret', secretName: 'token' },
		selection: { tags: ['widgets'] },
	})
	expect(parsed.includeDestructive).toBe(false)
})

test('selection resolution uses union semantics and excludes DELETE by default', () => {
	const operations = [
		op({
			slug: 'list_widgets',
			method: 'get',
			path: '/widgets',
			tags: ['widgets'],
		}),
		op({
			slug: 'create_widget',
			method: 'post',
			path: '/widgets',
			tags: ['widgets'],
		}),
		op({
			slug: 'delete_widget',
			method: 'delete',
			path: '/widgets/{id}',
			tags: ['widgets'],
		}),
		op({
			slug: 'get_user',
			method: 'get',
			path: '/users/{id}',
			tags: ['users'],
		}),
	]

	const byTag = resolveOpenApiSelection({
		operations,
		selection: { tags: ['WIDGETS'] },
		includeDestructive: false,
	})
	expect(byTag.operations.map((entry) => entry.slug)).toEqual([
		'create_widget',
		'list_widgets',
	])

	const byPrefix = resolveOpenApiSelection({
		operations,
		selection: { pathPrefixes: ['/users'] },
		includeDestructive: false,
	})
	expect(byPrefix.operations.map((entry) => entry.slug)).toEqual(['get_user'])

	const withWarning = resolveOpenApiSelection({
		operations,
		selection: { operationIds: ['delete_widget', 'list_widgets'] },
		includeDestructive: false,
	})
	expect(withWarning.operations.map((entry) => entry.slug)).toEqual([
		'list_widgets',
	])
	expect(withWarning.warnings[0]).toMatch(/delete_widget/)

	const withDelete = resolveOpenApiSelection({
		operations,
		selection: { tags: ['widgets'] },
		includeDestructive: true,
	})
	expect(withDelete.operations.map((entry) => entry.slug)).toEqual([
		'create_widget',
		'delete_widget',
		'list_widgets',
	])
})

test('selection operationIds match raw OpenAPI operationId values as well as slugs', () => {
	const operations = [
		op({
			slug: 'listwidgets',
			operationId: 'listWidgets',
			method: 'get',
			path: '/widgets',
		}),
		op({
			slug: 'deletewidget',
			operationId: 'deleteWidget',
			method: 'delete',
			path: '/widgets/{id}',
		}),
	]

	const byRawOperationId = resolveOpenApiSelection({
		operations,
		selection: { operationIds: ['listWidgets'] },
		includeDestructive: false,
	})
	expect(byRawOperationId.operations.map((entry) => entry.slug)).toEqual([
		'listwidgets',
	])

	const destructiveByRawId = resolveOpenApiSelection({
		operations,
		selection: { operationIds: ['deleteWidget', 'listwidgets'] },
		includeDestructive: false,
	})
	expect(destructiveByRawId.operations.map((entry) => entry.slug)).toEqual([
		'listwidgets',
	])
	expect(destructiveByRawId.warnings[0]).toMatch(/deletewidget/)
})

test('selection resolution errors on 0 or >100 matches', () => {
	expect(() =>
		resolveOpenApiSelection({
			operations: [
				op({
					slug: 'list_widgets',
					method: 'get',
					path: '/widgets',
					tags: ['widgets'],
				}),
			],
			selection: { tags: ['missing'] },
			includeDestructive: false,
		}),
	).toThrow(/matched 0 operations/)

	const many = Array.from(
		{ length: maxOpenApiBindingOperations + 1 },
		(_, index) =>
			op({
				slug: `op_${index}`,
				method: 'get',
				path: `/items/${index}`,
				tags: ['bulk'],
			}),
	)
	expect(() =>
		resolveOpenApiSelection({
			operations: many,
			selection: { tags: ['bulk'] },
			includeDestructive: false,
		}),
	).toThrow(/exceeding the max/)
})

test('serialized binding size cap rejects oversized snapshots', () => {
	const hugeDescription = 'x'.repeat(50_000)
	const operations = Array.from({ length: 40 }, (_, index) => ({
		slug: `op_${index}`,
		operationId: `op_${index}`,
		method: 'get' as const,
		path: `/items/${index}`,
		summary: hugeDescription,
		description: hugeDescription,
		tags: ['bulk'],
		deprecated: false,
		parameters: [],
		requestBody: {
			required: false,
			contentType: 'application/json',
			schema: { type: 'object', properties: { blob: { type: 'string' } } },
		},
	}))
	const binding = {
		name: 'huge',
		specUrl: 'https://specs.example/openapi.json',
		apiBaseUrl: 'https://api.example',
		description: hugeDescription,
		auth: { kind: 'none' as const },
		selection: { tags: ['bulk'] },
		includeDestructive: false,
		specTitle: 'Huge',
		specVersion: '1',
		operations,
		updatedAt: '2026-07-09T00:00:00.000Z',
	} satisfies OpenApiBinding

	expect(() => assertOpenApiBindingWithinSizeLimit(binding)).toThrow(
		/exceeding the .* values-store cap/,
	)
})
