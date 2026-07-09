import { expect, test } from 'vitest'
import { type OpenApiBinding } from '#worker/openapi/binding-shared.ts'
import {
	buildOpenApiOperationInputSchema,
	synthesizeOpenApiProviderDomain,
} from './index.ts'

function createBinding(
	overrides: Partial<OpenApiBinding> = {},
): OpenApiBinding {
	return {
		name: 'widgets',
		specUrl: 'https://specs.example/openapi.json',
		apiBaseUrl: 'https://api.widgets.example',
		description: 'Curated widgets API',
		auth: { kind: 'none' },
		selection: { tags: ['widgets'] },
		includeDestructive: true,
		specTitle: 'Widgets API',
		specVersion: '1.0.0',
		updatedAt: '2026-07-09T00:00:00.000Z',
		operations: [
			{
				slug: 'listwidgets',
				operationId: 'listWidgets',
				method: 'get',
				path: '/widgets',
				summary: 'List widgets',
				description: null,
				tags: ['widgets'],
				deprecated: false,
				parameters: [
					{
						name: 'limit',
						location: 'query',
						required: false,
						description: 'Max items',
						schema: { type: 'integer' },
					},
				],
				requestBody: null,
			},
			{
				slug: 'createwidget',
				operationId: 'createWidget',
				method: 'post',
				path: '/widgets',
				summary: null,
				description: 'Create a widget',
				tags: ['widgets'],
				deprecated: false,
				parameters: [],
				requestBody: {
					required: true,
					contentType: 'application/json',
					schema: {
						type: 'object',
						properties: { name: { type: 'string' } },
					},
				},
			},
			{
				slug: 'deletewidget',
				operationId: 'deleteWidget',
				method: 'delete',
				path: '/widgets/{widgetId}',
				summary: 'Delete widget',
				description: null,
				tags: ['widgets'],
				deprecated: false,
				parameters: [
					{
						name: 'widgetId',
						location: 'path',
						required: true,
						description: null,
						schema: { type: 'string' },
					},
				],
				requestBody: null,
			},
		],
		...overrides,
	}
}

test('synthesizes an openapi:<provider> domain with a capability per operation', () => {
	const synthesized = synthesizeOpenApiProviderDomain({
		binding: createBinding(),
	})

	expect(synthesized).not.toBeNull()
	expect(synthesized?.domain.name).toBe('openapi:widgets')
	expect(synthesized?.domain.capabilities.map((c) => c.name)).toEqual([
		'openapi:widgets:listwidgets',
		'openapi:widgets:createwidget',
		'openapi:widgets:deletewidget',
	])

	const list = synthesized?.domain.capabilities.find(
		(capability) => capability.name === 'openapi:widgets:listwidgets',
	)
	expect(list?.source).toBe('openapi')
	expect(list?.readOnly).toBe(true)
	expect(list?.destructive).toBe(false)
	expect(list?.openApi).toEqual({
		bindingName: 'widgets',
		kodyName: 'widgets',
		operationSlug: 'listwidgets',
		method: 'get',
		path: '/widgets',
	})
	expect(list?.description).toContain('GET /widgets')

	const create = synthesized?.domain.capabilities.find(
		(capability) => capability.name === 'openapi:widgets:createwidget',
	)
	expect(create?.readOnly).toBe(false)
	expect(create?.description).toContain('Create a widget')

	const del = synthesized?.domain.capabilities.find(
		(capability) => capability.name === 'openapi:widgets:deletewidget',
	)
	expect(del?.destructive).toBe(true)
	expect(del?.readOnly).toBe(false)

	expect(
		synthesizeOpenApiProviderDomain({
			binding: createBinding({ operations: [] }),
		}),
	).toBeNull()
})

test('input schema includes params/query/headers/body with required rules', () => {
	const binding = createBinding()
	const deleteOp = binding.operations[2]!
	const schema = buildOpenApiOperationInputSchema(deleteOp) as {
		required?: Array<string>
		properties: Record<string, unknown>
	}
	expect(schema.required).toEqual(['params'])
	expect(schema.properties.params).toMatchObject({
		type: 'object',
		required: ['widgetId'],
	})
	expect(schema.properties.headers).toMatchObject({ type: 'object' })

	const createOp = binding.operations[1]!
	const createSchema = buildOpenApiOperationInputSchema(createOp) as {
		required?: Array<string>
		properties: Record<string, unknown>
	}
	expect(createSchema.required).toEqual(['body'])
	expect(createSchema.properties.body).toMatchObject({
		type: 'object',
	})
})

test('input schema models required header/query params and cookie notes', () => {
	const schema = buildOpenApiOperationInputSchema({
		slug: 'search',
		operationId: 'search',
		method: 'get',
		path: '/search',
		summary: 'Search',
		description: null,
		tags: ['widgets'],
		deprecated: false,
		parameters: [
			{
				name: 'q',
				location: 'query',
				required: true,
				description: 'Query string',
				schema: { type: 'string' },
			},
			{
				name: 'X-Request-Id',
				location: 'header',
				required: true,
				description: 'Correlation id',
				schema: { type: 'string' },
			},
			{
				name: 'session',
				location: 'cookie',
				required: false,
				description: null,
				schema: { type: 'string' },
			},
			{
				name: 'csrf',
				location: 'cookie',
				required: true,
				description: null,
				schema: { type: 'string' },
			},
		],
		requestBody: null,
	}) as {
		required?: Array<string>
		properties: {
			query?: {
				required?: Array<string>
				properties?: Record<string, unknown>
			}
			headers?: {
				required?: Array<string>
				properties?: Record<string, unknown>
				description?: string
				additionalProperties?: unknown
			}
		}
	}

	expect(schema.required).toEqual(expect.arrayContaining(['query', 'headers']))
	expect(schema.properties.query).toMatchObject({
		required: ['q'],
		properties: { q: { type: 'string' } },
	})
	expect(schema.properties.headers).toMatchObject({
		required: ['X-Request-Id'],
		properties: { 'X-Request-Id': { type: 'string' } },
		additionalProperties: { type: 'string' },
	})
	expect(schema.properties.headers?.description).toContain(
		'Cookie parameters from the spec (session, csrf) must be passed manually via a "cookie" header.',
	)
})

test('domain description falls back to specTitle then default', () => {
	const withTitle = synthesizeOpenApiProviderDomain({
		binding: createBinding({ description: null, specTitle: 'Widgets API' }),
	})
	expect(withTitle?.domain.description).toBe('Widgets API')

	const fallback = synthesizeOpenApiProviderDomain({
		binding: createBinding({ description: null, specTitle: null }),
	})
	expect(fallback?.domain.description).toMatch(/widgets/)
})
