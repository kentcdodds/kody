import { expect, test } from 'vitest'
import { capabilityMap } from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { errorFields, logMcpEvent } from '#mcp/observability.ts'

test('errorFields normalizes Error and non-Error values', () => {
	expect(errorFields(new TypeError('bad'))).toEqual({
		errorName: 'TypeError',
		errorMessage: 'bad',
	})
	expect(errorFields('plain')).toEqual({
		errorName: 'Unknown',
		errorMessage: 'plain',
	})
})

test('logMcpEvent writes mcp-event with JSON payload', () => {
	const originalInfo = console.info
	let tagArg: unknown
	let jsonArg: unknown
	console.info = ((tag: unknown, json?: unknown) => {
		tagArg = tag
		jsonArg = json
	}) as typeof console.info
	try {
		logMcpEvent({
			category: 'mcp',
			tool: 'search',
			toolName: 'search',
			outcome: 'success',
			durationMs: 42,
			baseUrl: 'https://example.com',
			hasUser: false,
		})
	} finally {
		console.info = originalInfo
	}

	expect(tagArg).toBe('mcp-event')
	expect(typeof jsonArg).toBe('string')
	const parsed = JSON.parse(jsonArg as string) as Record<string, unknown>
	expect(parsed.category).toBe('mcp')
	expect(parsed.tool).toBe('search')
	expect(parsed.outcome).toBe('success')
	expect(parsed.durationMs).toBe(42)
	expect(typeof parsed.timestamp).toBe('string')
})

test('logMcpEvent swallows failures from console.info', () => {
	const originalInfo = console.info
	const originalWarn = console.warn
	console.info = (() => {
		throw new Error('console boom')
	}) as typeof console.info
	let warnArgs: unknown
	console.warn = ((...args: unknown[]) => {
		warnArgs = args
	}) as typeof console.warn
	try {
		expect(() =>
			logMcpEvent({
				category: 'mcp',
				tool: 'search',
				toolName: 'search',
				outcome: 'success',
				durationMs: 1,
				baseUrl: 'https://example.com',
				hasUser: false,
			}),
		).not.toThrow()
		expect(Array.isArray(warnArgs) && warnArgs[0]).toBe('mcp-event-failed')
	} finally {
		console.info = originalInfo
		console.warn = originalWarn
	}
})

test('ui_save_app capability logs parse_input failure and rethrows', async () => {
	const originalInfo = console.info
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	try {
		const handler = capabilityMap['ui_save_app'].handler
		await expect(
			handler(
				{ title: 'Missing fields' },
				{
					env: {} as Env,
					callerContext: createMcpCallerContext({
						baseUrl: 'https://example.com',
					}),
				},
			),
		).rejects.toThrow()
	} finally {
		console.info = originalInfo
	}

	expect(payloads.length).toBe(1)
	const event = JSON.parse(payloads[0]!) as Record<string, unknown>
	expect(event.tool).toBe('capability')
	expect(event.capabilityName).toBe('ui_save_app')
	expect(event.outcome).toBe('failure')
	expect(event.failurePhase).toBe('parse_input')
})

test('logMcpEvent reports failure without throwing when Sentry is off', () => {
	const originalInfo = console.info
	console.info = () => {}
	try {
		expect(() =>
			logMcpEvent({
				category: 'mcp',
				tool: 'search',
				toolName: 'search',
				outcome: 'failure',
				durationMs: 1,
				baseUrl: 'https://example.com',
				hasUser: false,
				sandboxError: true,
				errorName: 'Error',
				errorMessage: 'user code failed',
				cause: new Error('user code failed'),
			}),
		).not.toThrow()
	} finally {
		console.info = originalInfo
	}
})

test('ui_save_app capability logs success for valid invocation', async () => {
	const originalInfo = console.info
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	try {
		const handler = capabilityMap['ui_save_app'].handler
		const result = await handler(
			{
				title: 'Observed app',
				description: 'Observation test app.',
				code: 'document.querySelector("#app")!.innerHTML = "<h1>Observed app</h1>"',
			},
			{
				env: {
					APP_DB: {
						prepare() {
							return {
								bind() {
									return {
										run: async () => ({
											meta: { changes: 1 },
										}),
									}
								},
							}
						},
					},
				} as unknown as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: 'user-1',
						email: 'user@example.com',
					},
				}),
			},
		)
		expect(typeof (result as { app_id: string }).app_id).toBe('string')
		expect((result as { hidden: boolean }).hidden).toBe(true)
	} finally {
		console.info = originalInfo
	}

	expect(payloads.length).toBe(1)
	const event = JSON.parse(payloads[0]!) as Record<string, unknown>
	expect(event.outcome).toBe('success')
	expect(event.failurePhase).toBeUndefined()
})

test('ui_save_app logs vector refresh failure for in-place updates and still succeeds', async () => {
	const originalInfo = console.info
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	try {
		const handler = capabilityMap['ui_save_app'].handler
		const result = await handler(
			{
				app_id: 'app-1',
				title: 'Observed app',
				description: 'Observation test app.',
				code: '<main><h1>Observed app</h1></main>',
					hidden: false,
			},
			{
				env: {
					APP_DB: {
						prepare() {
							return {
								bind() {
									return {
										run: async () => ({
											meta: { changes: 1 },
										}),
									}
								},
							}
						},
					},
					CAPABILITY_VECTOR_INDEX: {
						upsert: async () => {
							throw new Error('vector refresh failed')
						},
					},
					AI: {
						run: async () => ({
							data: [Array.from({ length: 384 }, () => 0)],
						}),
					},
				} as unknown as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: 'user-1',
						email: 'user@example.com',
					},
				}),
			},
		)
		expect((result as { app_id: string }).app_id).toBe('app-1')
	} finally {
		console.info = originalInfo
	}

	expect(payloads.length).toBe(2)
	const driftEvent = JSON.parse(payloads[0]!) as Record<string, unknown>
	const driftContext = driftEvent.context as Record<string, unknown> | undefined
	expect(driftEvent.outcome).toBe('failure')
	expect(driftEvent.failurePhase).toBe('handler')
	expect(driftEvent.errorName).toBe('Error')
	expect(driftEvent.errorMessage).toBe('vector refresh failed')
	expect(driftEvent.message).toBe(
		'Failed to refresh saved app vector index after in-place update.',
	)
	expect(driftEvent.capabilityName).toBe('ui_save_app')
	expect(driftContext).toEqual({
		userId: 'user-1',
		appId: 'app-1',
		isUpdate: true,
	})

	const successEvent = JSON.parse(payloads[1]!) as Record<string, unknown>
	expect(successEvent.outcome).toBe('success')
	expect(successEvent.capabilityName).toBe('ui_save_app')
})
