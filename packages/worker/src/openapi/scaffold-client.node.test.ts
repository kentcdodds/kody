import { expect, test } from 'vitest'
import { scaffoldOpenApiClient } from './scaffold-client.ts'
import { type OpenApiOperation, type ParsedOpenApiSpec } from './spec-types.ts'

function baseSpec(
	overrides: Partial<ParsedOpenApiSpec> = {},
): ParsedOpenApiSpec {
	return {
		openapiVersion: '3.0.3',
		title: 'Widgets API',
		version: '1.2.0',
		description: null,
		servers: [{ url: 'https://api.widgets.example/v1', description: null }],
		operations: [],
		securitySchemes: [],
		defaultSecuritySchemeNames: [],
		warnings: [],
		...overrides,
	}
}

function op(
	partial: Partial<OpenApiOperation> &
		Pick<OpenApiOperation, 'method' | 'path' | 'slug'>,
): OpenApiOperation {
	return {
		operationId: null,
		summary: null,
		description: null,
		tags: [],
		deprecated: false,
		parameters: [],
		requestBody: null,
		securitySchemeNames: [],
		...partial,
	}
}

type RecordedCall = {
	input: RequestInfo | URL
	init: RequestInit | undefined
}

async function importScaffold(moduleSource: string) {
	const href =
		'data:text/javascript;base64,' +
		Buffer.from(moduleSource).toString('base64')
	return import(href)
}

function recordingFetch() {
	const calls: Array<RecordedCall> = []
	const fetchImpl = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		calls.push({ input, init })
		return new Response('{}', { status: 200 })
	}
	return { calls, fetchImpl }
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
	const headers = init?.headers
	if (!headers) return {}
	if (headers instanceof Headers) {
		return Object.fromEntries(headers.entries())
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers)
	}
	return { ...headers }
}

const listWidgets = op({
	slug: 'list_widgets',
	method: 'get',
	path: '/widgets',
	summary: 'List widgets',
	parameters: [
		{
			name: 'limit',
			location: 'query',
			required: false,
			description: null,
			schema: { type: 'integer' },
		},
		{
			name: 'tag',
			location: 'query',
			required: false,
			description: null,
			schema: { type: 'array' },
		},
	],
})

const getWidget = op({
	slug: 'get_widget',
	method: 'get',
	path: '/widgets/{widgetId}',
	summary: 'Get a widget by id',
	parameters: [
		{
			name: 'widgetId',
			location: 'path',
			required: true,
			description: null,
			schema: { type: 'string' },
		},
	],
})

const createWidget = op({
	slug: 'create_widget',
	method: 'post',
	path: '/widgets',
	summary: 'Create widget',
	requestBody: {
		required: true,
		contentType: 'application/json',
		schema: { type: 'object' },
	},
})

const uploadWidget = op({
	slug: 'upload_widget',
	method: 'post',
	path: '/widgets/upload',
	summary: 'Upload raw bytes',
	requestBody: {
		required: true,
		contentType: 'application/octet-stream',
		schema: null,
	},
})

test('scaffoldOpenApiClient builds URL, method, query, and JSON body for bearer auth', async () => {
	const scaffold = scaffoldOpenApiClient({
		spec: baseSpec({
			operations: [listWidgets, getWidget, createWidget],
		}),
		operationSlugs: ['list_widgets', 'get_widget', 'create_widget'],
		auth: { kind: 'bearerSecret', secretName: 'tok' },
		apiBaseUrl: 'https://api.widgets.example/v1/',
	})

	expect(scaffold.operations.map((entry) => entry.exportName)).toEqual([
		'listWidgets',
		'getWidget',
		'createWidget',
	])
	expect(scaffold.warnings).toEqual([])

	const mod = await importScaffold(scaffold.moduleSource)
	const { calls, fetchImpl } = recordingFetch()

	await mod.listWidgets(
		{
			query: { limit: 10, tag: ['a', 'b'], unused: null, skip: undefined },
			headers: { 'x-trace': '1' },
		},
		{ fetchImpl },
	)
	expect(String(calls[0]?.input)).toBe(
		'https://api.widgets.example/v1/widgets?limit=10&tag=a&tag=b',
	)
	expect(calls[0]?.init?.method).toBe('GET')
	expect(headersOf(calls[0]?.init)).toMatchObject({
		Authorization: 'Bearer {{secret:tok}}',
		'x-trace': '1',
	})

	await mod.getWidget({ params: { widgetId: 'w/1' } }, { fetchImpl })
	expect(String(calls[1]?.input)).toBe(
		'https://api.widgets.example/v1/widgets/w%2F1',
	)

	await mod.createWidget(
		{ body: { name: 'n' }, headers: { Authorization: 'Bearer stolen' } },
		{ fetchImpl },
	)
	const createHeaders = headersOf(calls[2]?.init)
	expect(createHeaders.Authorization).toBe('Bearer {{secret:tok}}')
	expect(createHeaders['content-type']).toBe('application/json')
	expect(calls[2]?.init?.body).toBe(JSON.stringify({ name: 'n' }))
	expect(calls[2]?.init?.method).toBe('POST')
})

test('scaffoldOpenApiClient injects headerSecret, basicSecrets, integration auth, and none auth', async () => {
	const headerScaffold = scaffoldOpenApiClient({
		spec: baseSpec({ operations: [listWidgets] }),
		operationSlugs: ['list_widgets'],
		auth: {
			kind: 'headerSecret',
			headerName: 'X-Api-Key',
			secretName: 'apiKey',
		},
		apiBaseUrl: 'https://api.widgets.example',
	})
	const headerMod = await importScaffold(headerScaffold.moduleSource)
	const headerRec = recordingFetch()
	await headerMod.listWidgets(
		{ headers: { 'X-Api-Key': 'nope', 'x-extra': '1' } },
		{ fetchImpl: headerRec.fetchImpl },
	)
	expect(headersOf(headerRec.calls[0]?.init)).toMatchObject({
		'X-Api-Key': '{{secret:apiKey}}',
		'x-extra': '1',
	})

	const basicScaffold = scaffoldOpenApiClient({
		spec: baseSpec({ operations: [listWidgets] }),
		operationSlugs: ['list_widgets'],
		auth: {
			kind: 'basicSecrets',
			usernameSecret: 'user',
			passwordSecret: 'pass',
		},
		apiBaseUrl: 'https://api.widgets.example',
	})
	const basicMod = await importScaffold(basicScaffold.moduleSource)
	const basicRec = recordingFetch()
	await basicMod.listWidgets(
		{ headers: { Authorization: 'Basic override' } },
		{ fetchImpl: basicRec.fetchImpl },
	)
	expect(headersOf(basicRec.calls[0]?.init).Authorization).toBe(
		'{{secret-basic:username=user,password=pass}}',
	)

	const noneScaffold = scaffoldOpenApiClient({
		spec: baseSpec({ operations: [listWidgets] }),
		operationSlugs: ['list_widgets'],
		auth: { kind: 'none' },
		apiBaseUrl: 'https://api.widgets.example',
	})
	const noneMod = await importScaffold(noneScaffold.moduleSource)
	const noneRec = recordingFetch()
	await noneMod.listWidgets(
		{ headers: { 'x-a': '1' } },
		{ fetchImpl: noneRec.fetchImpl },
	)
	expect(headersOf(noneRec.calls[0]?.init)).toEqual({ 'x-a': '1' })

	const integrationScaffold = scaffoldOpenApiClient({
		spec: baseSpec({ operations: [listWidgets] }),
		operationSlugs: ['list_widgets'],
		auth: { kind: 'integration', provider: 'widgets-prod' },
		apiBaseUrl: 'https://api.widgets.example',
		providerLabel: 'Widgets',
	})
	const integrationMod = await importScaffold(integrationScaffold.moduleSource)
	const integrationRec = recordingFetch()
	await integrationMod.listWidgets({}, { fetchImpl: integrationRec.fetchImpl })
	expect(String(integrationRec.calls[0]?.input)).toBe(
		'https://api.widgets.example/widgets',
	)
	expect(headersOf(integrationRec.calls[0]?.init)).toEqual({})
})

test('scaffoldOpenApiClient throws when a required path param is missing', async () => {
	const scaffold = scaffoldOpenApiClient({
		spec: baseSpec({ operations: [getWidget] }),
		operationSlugs: ['get_widget'],
		auth: { kind: 'none' },
		apiBaseUrl: 'https://api.widgets.example',
	})
	const mod = await importScaffold(scaffold.moduleSource)
	const { fetchImpl } = recordingFetch()
	await expect(mod.getWidget({}, { fetchImpl })).rejects.toThrow(
		/Missing required path parameter: widgetId/,
	)
})

test('scaffoldOpenApiClient warns on unknown slugs and throws when none resolve', () => {
	const withWarning = scaffoldOpenApiClient({
		spec: baseSpec({ operations: [listWidgets] }),
		operationSlugs: ['list_widgets', 'missing_op'],
		auth: { kind: 'none' },
		apiBaseUrl: 'https://api.widgets.example',
	})
	expect(withWarning.warnings).toEqual(['Unknown operation slug: missing_op'])
	expect(withWarning.operations).toHaveLength(1)

	expect(() =>
		scaffoldOpenApiClient({
			spec: baseSpec({ operations: [listWidgets] }),
			operationSlugs: ['missing_op'],
			auth: { kind: 'none' },
			apiBaseUrl: 'https://api.widgets.example',
		}),
	).toThrow(/No resolvable operations/)
})

test('scaffoldOpenApiClient passes non-JSON bodies through with the operation content type', async () => {
	const streamWidget = op({
		slug: 'stream_widget',
		method: 'post',
		path: '/widgets/stream',
		summary: 'Stream JSON sequence',
		requestBody: {
			required: true,
			contentType: 'application/json-seq',
			schema: null,
		},
	})
	const scaffold = scaffoldOpenApiClient({
		spec: baseSpec({ operations: [uploadWidget, streamWidget] }),
		operationSlugs: ['upload_widget', 'stream_widget'],
		auth: { kind: 'none' },
		apiBaseUrl: 'https://api.widgets.example',
	})
	const mod = await importScaffold(scaffold.moduleSource)
	const { calls, fetchImpl } = recordingFetch()
	const rawPayload = 'raw-bytes'
	await mod.uploadWidget({ body: rawPayload }, { fetchImpl })
	expect(calls[0]?.init?.body).toBe(rawPayload)
	expect(headersOf(calls[0]?.init)['content-type']).toBe(
		'application/octet-stream',
	)

	const jsonSeqPayload = '{"id":1}\n{"id":2}\n'
	await mod.streamWidget({ body: jsonSeqPayload }, { fetchImpl })
	expect(calls[1]?.init?.body).toBe(jsonSeqPayload)
	expect(headersOf(calls[1]?.init)['content-type']).toBe('application/json-seq')
})

test('scaffoldOpenApiClient escapes hostile path and summary so the module stays importable', async () => {
	const hostile = op({
		slug: 'hostile_op',
		method: 'get',
		path: "/x'); process.exit(1); //{id}",
		summary: 'Evil */ process.exit(1); //',
		parameters: [
			{
				name: 'id',
				location: 'path',
				required: true,
				description: null,
				schema: { type: 'string' },
			},
		],
	})
	const scaffold = scaffoldOpenApiClient({
		spec: baseSpec({
			title: 'Evil */ title',
			operations: [hostile],
		}),
		operationSlugs: ['hostile_op'],
		auth: { kind: 'bearerSecret', secretName: 'tok' },
		apiBaseUrl: 'https://api.widgets.example',
	})

	expect(scaffold.moduleSource).not.toContain('*/ process.exit')
	expect(scaffold.moduleSource).toContain('*\\/')

	const mod = await importScaffold(scaffold.moduleSource)
	const { calls, fetchImpl } = recordingFetch()
	await mod.hostileOp({ params: { id: 'abc' } }, { fetchImpl })
	expect(String(calls[0]?.input)).toBe(
		"https://api.widgets.example/x'); process.exit(1); //abc",
	)
	expect(headersOf(calls[0]?.init).Authorization).toBe('Bearer {{secret:tok}}')
})

test('scaffoldOpenApiClient dedupes colliding camelCase export names', () => {
	const scaffold = scaffoldOpenApiClient({
		spec: baseSpec({
			operations: [
				op({ slug: 'get_item', method: 'get', path: '/a' }),
				op({ slug: 'get-item', method: 'get', path: '/b' }),
			],
		}),
		operationSlugs: ['get_item', 'get-item'],
		auth: { kind: 'none' },
		apiBaseUrl: 'https://api.widgets.example',
	})
	expect(scaffold.operations.map((entry) => entry.exportName)).toEqual([
		'getItem',
		'getItem2',
	])
})
