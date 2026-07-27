import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { openapiBindingDeleteCapability } from './openapi-binding-delete.ts'
import { openapiBindingGetCapability } from './openapi-binding-get.ts'
import { openapiBindingListCapability } from './openapi-binding-list.ts'
import { openapiBindingRefreshCapability } from './openapi-binding-refresh.ts'
import { openapiBindingSaveCapability } from './openapi-binding-save.ts'

const SPEC_URL = 'https://specs.example/openapi.json'
const API_BASE = 'https://api.widgets.example'

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)

function applyAllMigrations(db: DatabaseSync) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite)
	return {
		sqlite,
		env: { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env,
	}
}

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

function authedCtx(env: Env) {
	return {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123', email: 'user@example.com' },
		}),
	}
}

function bindingRowCount(sqlite: DatabaseSync, userId: string, name: string) {
	const row = sqlite
		.prepare(
			`SELECT count(*) AS count
			FROM user_openapi_bindings
			WHERE user_id = ? AND name = ?`,
		)
		.get(userId, name) as { count: number }
	return Number(row.count)
}

function operationRowCount(sqlite: DatabaseSync, userId: string, name: string) {
	const row = sqlite
		.prepare(
			`SELECT count(*) AS count
			FROM user_openapi_binding_operations
			WHERE user_id = ? AND binding_name = ?`,
		)
		.get(userId, name) as { count: number }
	return Number(row.count)
}

test('openapi binding save/list/get/delete/refresh round-trip', async () => {
	using _server = createMswNodeServer([
		http.get(SPEC_URL, () => HttpResponse.json(fixtureSpec)),
	])
	const { sqlite, env } = createEnv()
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
	expect(bindingRowCount(sqlite, 'user-123', 'widgets')).toBe(1)
	expect(operationRowCount(sqlite, 'user-123', 'widgets')).toBe(3)

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
	expect(bindingRowCount(sqlite, 'user-123', 'widgets')).toBe(0)
	expect(operationRowCount(sqlite, 'user-123', 'widgets')).toBe(0)
})

test('openapi binding save warns when explicit DELETE slug is excluded', async () => {
	using _server = createMswNodeServer([
		http.get(SPEC_URL, () => HttpResponse.json(fixtureSpec)),
	])
	const { env } = createEnv()

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
	const { env } = createEnv()
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
	const { env } = createEnv()
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
