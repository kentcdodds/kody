/// <reference types="bun" />
import { expect, test } from 'bun:test'
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

test('do_math capability logs parse_input failure and rethrows', async () => {
	const originalInfo = console.info
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	try {
		const handler = capabilityMap['do_math'].handler
		await expect(
			handler(
				{ left: 1, right: 2 },
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
	expect(event.capabilityName).toBe('do_math')
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

test('do_math capability logs success for valid invocation', async () => {
	const originalInfo = console.info
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	try {
		const handler = capabilityMap['do_math'].handler
		const result = await handler(
			{ left: 2, right: 3, operator: '+' },
			{
				env: {} as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
				}),
			},
		)
		expect((result as { result: number }).result).toBe(5)
	} finally {
		console.info = originalInfo
	}

	expect(payloads.length).toBe(1)
	const event = JSON.parse(payloads[0]!) as Record<string, unknown>
	expect(event.outcome).toBe('success')
	expect(event.failurePhase).toBeUndefined()
})
