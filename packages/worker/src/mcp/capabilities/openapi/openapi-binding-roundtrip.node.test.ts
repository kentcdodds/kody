import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { openapiBindingDeleteCapability } from './openapi-binding-delete.ts'
import { openapiBindingGetCapability } from './openapi-binding-get.ts'
import { openapiBindingListCapability } from './openapi-binding-list.ts'
import { openapiBindingRefreshCapability } from './openapi-binding-refresh.ts'
import { openapiBindingSaveCapability } from './openapi-binding-save.ts'

const SPEC_URL = 'https://specs.example/openapi.json'
const API_BASE = 'https://api.widgets.example'

const fixtureSpec = {
	openapi: '3.0.3',
	info: { title: 'Widgets API', version: '1.0.0' },
	paths: {
		'/widgets': {
			get: {
				operationId: 'listWidgets',
				summary: 'List widgets',
				tags: ['widgets'],
				responses: { '200': { description: 'ok' } },
			},
			post: {
				operationId: 'createWidget',
				summary: 'Create widget',
				tags: ['widgets'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: { name: { type: 'string' } },
							},
						},
					},
				},
				responses: { '201': { description: 'created' } },
			},
		},
		'/widgets/{widgetId}': {
			get: {
				operationId: 'getWidget',
				summary: 'Get widget',
				tags: ['widgets'],
				parameters: [
					{
						name: 'widgetId',
						in: 'path',
						required: true,
						schema: { type: 'string' },
					},
				],
				responses: { '200': { description: 'ok' } },
			},
			delete: {
				operationId: 'deleteWidget',
				summary: 'Delete widget',
				tags: ['widgets'],
				parameters: [
					{
						name: 'widgetId',
						in: 'path',
						required: true,
						schema: { type: 'string' },
					},
				],
				responses: { '204': { description: 'deleted' } },
			},
		},
	},
}

function createValueTestDb() {
	const entries = new Map<string, string>()
	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (
								normalizedQuery.startsWith('select') &&
								normalizedQuery.includes('from value_buckets')
							) {
								return {
									id: 'bucket-1',
									user_id: String(params[0]),
									scope: String(params[1]),
									binding_key: '',
									expires_at: null,
									created_at: '2026-03-29T00:00:00.000Z',
									updated_at: '2026-03-29T00:00:00.000Z',
								} as T
							}
							if (
								normalizedQuery.startsWith('select') &&
								normalizedQuery.includes('from value_entries') &&
								normalizedQuery.includes('where bucket_id = ? and name = ?')
							) {
								const name = String(params[1])
								const value = entries.get(name)
								return value == null
									? null
									: ({
											bucket_id: 'bucket-1',
											name,
											description: `OpenAPI provider binding for ${name}`,
											value,
											created_at: '2026-03-29T00:00:00.000Z',
											updated_at: '2026-03-29T00:00:00.000Z',
										} as T)
							}
							return null
						},
						async all<T>() {
							if (
								normalizedQuery.includes('from value_entries e') &&
								normalizedQuery.includes('inner join value_buckets b')
							) {
								const results = [...entries.entries()]
									.sort(([left], [right]) => left.localeCompare(right))
									.map(([name, value]) => ({
										scope: 'user',
										binding_key: '',
										name,
										description: `OpenAPI provider binding for ${name}`,
										value,
										created_at: '2026-03-29T00:00:00.000Z',
										updated_at: '2026-03-29T00:00:00.000Z',
										expires_at: null,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async run() {
							if (normalizedQuery.startsWith('insert into value_entries')) {
								const name = String(params[1])
								const value = String(params[3])
								entries.set(name, value)
								return { meta: { changes: 1 } }
							}
							if (normalizedQuery.startsWith('delete from value_entries')) {
								const name = String(params[1])
								const deleted = entries.delete(name)
								return { meta: { changes: deleted ? 1 : 0 } }
							}
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return { db, entries }
}

function authedCtx(env: Env) {
	return {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123', email: 'user@example.com' },
		}),
	}
}

test('openapi binding save/list/get/delete/refresh round-trip', async () => {
	using _server = createMswNodeServer([
		http.get(SPEC_URL, () => HttpResponse.json(fixtureSpec)),
	])
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db } as unknown as Env
	const ctx = authedCtx(env)

	const saved = await openapiBindingSaveCapability.handler(
		{
			name: 'widgets',
			specUrl: SPEC_URL,
			apiBaseUrl: API_BASE,
			auth: { kind: 'none' },
			selection: { tags: ['widgets'] },
			includeDestructive: false,
		},
		ctx,
	)
	expect(saved.binding.name).toBe('widgets')
	expect(saved.binding.operationCount).toBe(3)
	expect(saved.operationSlugs).toEqual([
		'createwidget',
		'getwidget',
		'listwidgets',
	])
	expect(saved.warnings.some((warning) => /delete/i.test(warning))).toBe(false)
	expect(testDb.entries.has('_openapi:widgets')).toBe(true)

	const listed = await openapiBindingListCapability.handler({}, ctx)
	expect(listed.bindings).toHaveLength(1)
	expect(listed.bindings[0]).toMatchObject({
		name: 'widgets',
		specUrl: SPEC_URL,
		apiBaseUrl: API_BASE,
		authKind: 'none',
		operationCount: 3,
		specTitle: 'Widgets API',
	})
	expect(listed.bindings[0]).not.toHaveProperty('operations')

	const got = await openapiBindingGetCapability.handler(
		{ name: 'widgets' },
		ctx,
	)
	expect(got.binding?.operations.map((entry) => entry.slug)).toEqual([
		'createwidget',
		'getwidget',
		'listwidgets',
	])
	expect(got.binding?.operations[0]).not.toHaveProperty('parameters')

	const refreshed = await openapiBindingRefreshCapability.handler(
		{ name: 'widgets' },
		ctx,
	)
	expect(refreshed.added).toEqual([])
	expect(refreshed.removed).toEqual([])
	expect(refreshed.changed).toEqual([])
	expect(refreshed.binding.operationCount).toBe(3)

	const deleted = await openapiBindingDeleteCapability.handler(
		{ name: 'widgets' },
		ctx,
	)
	expect(deleted.deleted).toBe(true)
	expect(testDb.entries.has('_openapi:widgets')).toBe(false)
})

test('openapi binding save warns when explicit DELETE slug is excluded', async () => {
	using _server = createMswNodeServer([
		http.get(SPEC_URL, () => HttpResponse.json(fixtureSpec)),
	])
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db } as unknown as Env

	const saved = await openapiBindingSaveCapability.handler(
		{
			name: 'widgets',
			specUrl: SPEC_URL,
			apiBaseUrl: API_BASE,
			auth: { kind: 'none' },
			selection: { operationIds: ['deletewidget', 'listwidgets'] },
		},
		authedCtx(env),
	)
	expect(saved.operationSlugs).toEqual(['listwidgets'])
	expect(saved.warnings.some((warning) => /deletewidget/.test(warning))).toBe(
		true,
	)
})

test('openapi binding capabilities require authenticated user', async () => {
	using _server = createMswNodeServer([
		http.get(SPEC_URL, () => HttpResponse.json(fixtureSpec)),
	])
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db } as unknown as Env
	const unauth = {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
		}),
	}

	await expect(
		openapiBindingSaveCapability.handler(
			{
				name: 'widgets',
				specUrl: SPEC_URL,
				apiBaseUrl: API_BASE,
				auth: { kind: 'none' },
				selection: { tags: ['widgets'] },
			},
			unauth,
		),
	).rejects.toThrow(/Authenticated MCP user/)

	await expect(
		openapiBindingListCapability.handler({}, unauth),
	).rejects.toThrow(/Authenticated MCP user/)
})

test('openapi binding refresh reports added/removed/changed slugs', async () => {
	const v1 = {
		...fixtureSpec,
		paths: {
			'/widgets': fixtureSpec.paths['/widgets'],
		},
	}
	const v2 = {
		...fixtureSpec,
		paths: {
			'/widgets': {
				get: {
					...fixtureSpec.paths['/widgets'].get,
					summary: 'List all widgets',
				},
			},
			'/health': {
				get: {
					operationId: 'getHealth',
					summary: 'Health',
					tags: ['widgets'],
					responses: { '200': { description: 'ok' } },
				},
			},
		},
	}

	let current = v1
	using _server = createMswNodeServer([
		http.get(SPEC_URL, () => HttpResponse.json(current)),
	])
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db } as unknown as Env
	const ctx = authedCtx(env)

	await openapiBindingSaveCapability.handler(
		{
			name: 'widgets',
			specUrl: SPEC_URL,
			apiBaseUrl: API_BASE,
			auth: { kind: 'none' },
			selection: { tags: ['widgets'] },
		},
		ctx,
	)

	current = v2
	const refreshed = await openapiBindingRefreshCapability.handler(
		{ name: 'widgets' },
		ctx,
	)
	expect(refreshed.added).toEqual(['gethealth'])
	expect(refreshed.removed).toEqual(['createwidget'])
	expect(refreshed.changed).toEqual(['listwidgets'])
})
