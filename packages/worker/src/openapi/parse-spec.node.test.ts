import { expect, test } from 'vitest'
import { deriveOperationSlug, parseOpenApiSpec } from './parse-spec.ts'

const minimalJsonSpec = {
	openapi: '3.0.3',
	info: {
		title: 'Widgets API',
		version: '1.2.3',
		description: 'A'.repeat(400),
	},
	servers: [
		{
			url: 'https://{env}.widgets.example/v1',
			description: 'Env-scoped API',
			variables: {
				env: { default: 'api', enum: ['api', 'staging'] },
			},
		},
	],
	components: {
		schemas: {
			Widget: {
				type: 'object',
				properties: {
					id: { type: 'string', 'x-internal': true },
					name: { type: 'string' },
				},
			},
			Node: {
				type: 'object',
				properties: {
					child: { $ref: '#/components/schemas/Node' },
				},
			},
			MissingTarget: {
				$ref: '#/components/schemas/DoesNotExist',
			},
		},
		securitySchemes: {
			ApiKeyAuth: {
				type: 'apiKey',
				in: 'header',
				name: 'X-Api-Key',
			},
		},
		parameters: {
			WidgetId: {
				name: 'widgetId',
				in: 'path',
				required: true,
				schema: { type: 'string' },
			},
		},
	},
	paths: {
		'/widgets': {
			get: {
				operationId: 'listWidgets',
				summary: 'List widgets',
				tags: ['widgets'],
				responses: { '200': { description: 'ok' } },
			},
			post: {
				summary: 'Create widget',
				tags: ['widgets'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/Widget' },
						},
					},
				},
				responses: { '201': { description: 'created' } },
			},
		},
		'/widgets/{widgetId}': {
			parameters: [{ $ref: '#/components/parameters/WidgetId' }],
			get: {
				operationId: 'getWidget',
				summary: 'Get widget',
				tags: ['widgets'],
				responses: { '200': { description: 'ok' } },
			},
			delete: {
				operationId: 'getWidget',
				summary: 'Delete widget',
				tags: ['widgets'],
				responses: { '204': { description: 'deleted' } },
			},
		},
		'/tree': {
			post: {
				summary: 'Create tree',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/Node' },
						},
					},
				},
				responses: { '200': { description: 'ok' } },
			},
		},
		'/broken': {
			get: {
				summary: 'Broken ref',
				requestBody: {
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/MissingTarget' },
						},
					},
				},
				responses: { '200': { description: 'ok' } },
			},
		},
	},
}

test('parseOpenApiSpec accepts OpenAPI 3.0 JSON and truncates long descriptions', () => {
	const parsed = parseOpenApiSpec(JSON.stringify(minimalJsonSpec))
	expect(parsed.openapiVersion).toBe('3.0.3')
	expect(parsed.title).toBe('Widgets API')
	expect(parsed.version).toBe('1.2.3')
	expect(parsed.description?.endsWith('…')).toBe(true)
	expect(parsed.description?.length).toBeLessThanOrEqual(300)
	expect(parsed.servers).toEqual([
		{
			url: 'https://api.widgets.example/v1',
			description: 'Env-scoped API',
		},
	])
	expect(parsed.operations.length).toBeGreaterThanOrEqual(5)
})

test('parseOpenApiSpec accepts OpenAPI 3.1 YAML', () => {
	const yaml = `
openapi: 3.1.0
info:
  title: YAML API
  version: "0.1"
paths:
  /ping:
    get:
      operationId: ping
      responses:
        "200":
          description: ok
`
	const parsed = parseOpenApiSpec(yaml)
	expect(parsed.openapiVersion).toBe('3.1.0')
	expect(parsed.title).toBe('YAML API')
	expect(parsed.operations).toHaveLength(1)
	expect(parsed.operations[0]?.slug).toBe('ping')
})

test('parseOpenApiSpec rejects Swagger 2.0', () => {
	expect(() =>
		parseOpenApiSpec(
			JSON.stringify({
				swagger: '2.0',
				info: { title: 'Old', version: '1' },
				paths: {},
			}),
		),
	).toThrow(/Swagger 2\.0 is not supported/)
})

test('parseOpenApiSpec resolves local $refs and warns on unresolvable refs', () => {
	const parsed = parseOpenApiSpec(JSON.stringify(minimalJsonSpec))
	const create = parsed.operations.find((op) => op.slug === 'post_widgets')
	expect(create?.requestBody?.schema).toEqual({
		type: 'object',
		properties: {
			id: { type: 'string' },
			name: { type: 'string' },
		},
	})
	expect(create?.requestBody?.schema).not.toHaveProperty('x-internal')

	const getWidget = parsed.operations.find((op) => op.slug === 'getwidget')
	expect(getWidget?.parameters[0]).toMatchObject({
		name: 'widgetId',
		location: 'path',
		required: true,
	})

	expect(
		parsed.warnings.some((warning) =>
			warning.includes('unresolvable local $ref'),
		),
	).toBe(true)
})

test('parseOpenApiSpec does not hang on cyclic local schema refs', () => {
	const started = Date.now()
	const parsed = parseOpenApiSpec(JSON.stringify(minimalJsonSpec))
	expect(Date.now() - started).toBeLessThan(2_000)
	const tree = parsed.operations.find((op) => op.path === '/tree')
	expect(tree).toBeDefined()
	expect(
		parsed.warnings.some(
			(warning) =>
				warning.includes('cyclic local $ref') ||
				warning.includes('schema truncated'),
		),
	).toBe(true)
})

test('deriveOperationSlug and dedupe follow contract rules', () => {
	expect(deriveOperationSlug('List Widgets!', 'get', '/widgets')).toBe(
		'list_widgets',
	)
	expect(deriveOperationSlug(null, 'get', '/widgets/{id}')).toBe(
		'get_widgets_id',
	)
	expect(deriveOperationSlug('!!!', 'post', '///')).toBe('operation')

	const parsed = parseOpenApiSpec(JSON.stringify(minimalJsonSpec))
	const slugs = parsed.operations.map((op) => op.slug)
	// operationId camelCase lowercases without inserted underscores
	expect(slugs).toContain('listwidgets')
	// missing operationId falls back to method_path
	expect(slugs).toContain('post_widgets')
	// duplicate operationIds get _2 suffix in document order
	expect(slugs).toContain('getwidget')
	expect(slugs).toContain('getwidget_2')
})

test('dedupeSlug skips already-used numbered suffixes (foo, foo, foo_2)', () => {
	const parsed = parseOpenApiSpec(
		JSON.stringify({
			openapi: '3.0.3',
			info: { title: 'Collision', version: '1' },
			paths: {
				'/a': {
					get: {
						operationId: 'foo',
						responses: { '200': { description: 'ok' } },
					},
				},
				'/b': {
					get: {
						operationId: 'foo',
						responses: { '200': { description: 'ok' } },
					},
				},
				'/c': {
					get: {
						operationId: 'foo_2',
						responses: { '200': { description: 'ok' } },
					},
				},
			},
		}),
	)
	const slugs = parsed.operations.map((op) => op.slug)
	// Second "foo" claims foo_2; the later base "foo_2" is already taken so becomes foo_2_2.
	expect(slugs).toEqual(['foo', 'foo_2', 'foo_2_2'])
	expect(new Set(slugs).size).toBe(3)
})

test('parseOpenApiSpec warns when operation hard cap is exceeded', () => {
	const paths: Record<string, unknown> = {}
	for (let index = 0; index < 2001; index += 1) {
		paths[`/item-${index}`] = {
			get: {
				operationId: `getItem${index}`,
				responses: { '200': { description: 'ok' } },
			},
		}
	}
	const parsed = parseOpenApiSpec(
		JSON.stringify({
			openapi: '3.0.0',
			info: { title: 'Huge', version: '1' },
			paths,
		}),
	)
	expect(parsed.operations).toHaveLength(2000)
	expect(
		parsed.warnings.some((warning) =>
			warning.includes('operation count exceeded 2000'),
		),
	).toBe(true)
})
