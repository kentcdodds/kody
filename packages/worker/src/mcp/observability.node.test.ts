import { expect, test, vi } from 'vitest'

const sentryMock = vi.hoisted(() => ({
	isInitialized: vi.fn(() => true),
	getClient: vi.fn(() => ({ getOptions: () => ({ dsn: 'https://example' }) })),
	withScope: vi.fn((callback: (scope: ScopeStub) => void) => {
		callback(sentryMock.scope)
	}),
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	scope: {
		setLevel: vi.fn(),
		setTag: vi.fn(),
		setContext: vi.fn(),
		setUser: vi.fn(),
	},
}))

type ScopeStub = typeof sentryMock.scope

vi.mock('@sentry/cloudflare', () => ({
	isInitialized: (...args: Array<unknown>) => sentryMock.isInitialized(...args),
	getClient: (...args: Array<unknown>) => sentryMock.getClient(...args),
	withScope: (...args: Array<unknown>) => sentryMock.withScope(...args),
	captureException: (...args: Array<unknown>) =>
		sentryMock.captureException(...args),
	captureMessage: (...args: Array<unknown>) =>
		sentryMock.captureMessage(...args),
}))

const { logMcpEvent } = await import('./observability.ts')
const { McpCallerError } = await import('./caller-error.ts')

function captureMcpEvents(run: () => void) {
	sentryMock.captureException.mockClear()
	sentryMock.captureMessage.mockClear()
	sentryMock.withScope.mockClear()
	sentryMock.scope.setLevel.mockClear()

	const originalInfo = console.info
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	try {
		run()
	} finally {
		console.info = originalInfo
	}
	return payloads
}

const callerFailureBase = {
	category: 'mcp',
	tool: 'capability',
	outcome: 'failure',
	durationMs: 3,
	baseUrl: 'https://example.com',
	hasUser: true,
	userId: 'user-1',
} as const

test('logMcpEvent keeps sandbox failures on mcp-event logs and skips Sentry', () => {
	const payloads = captureMcpEvents(() => {
		logMcpEvent({
			category: 'mcp',
			tool: 'execute',
			toolName: 'execute',
			outcome: 'failure',
			durationMs: 12,
			baseUrl: 'https://example.com',
			hasUser: true,
			userId: 'user-1',
			sandboxError: true,
			errorName: 'Unknown',
			errorMessage:
				'Notion API /data_sources/39977ef0-f2db-81c6-9147-000bd579e312/query failed: validation_error',
			cause: 'Notion API /data_sources/.../query failed: validation_error',
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'value_get',
			capabilitySource: 'builtin',
			sandboxError: false,
			failurePhase: 'handler',
			errorName: 'Error',
			errorMessage: 'platform handler blew up',
			cause: new Error('platform handler blew up'),
		})
	})

	expect(payloads).toHaveLength(2)
	expect(JSON.parse(payloads[0]!)).toMatchObject({
		tool: 'execute',
		outcome: 'failure',
		sandboxError: true,
	})
	expect(JSON.parse(payloads[1]!)).toMatchObject({
		tool: 'capability',
		outcome: 'failure',
		sandboxError: false,
	})

	expect(sentryMock.captureMessage).not.toHaveBeenCalled()
	expect(sentryMock.captureException).toHaveBeenCalledTimes(1)
	expect(sentryMock.captureException).toHaveBeenCalledWith(
		expect.objectContaining({ message: 'platform handler blew up' }),
	)
	expect(sentryMock.scope.setLevel).toHaveBeenCalledWith('error')
	expect(sentryMock.scope.setUser).toHaveBeenCalledWith({ id: 'user-1' })
})

test('logMcpEvent keeps caller mistakes out of Sentry', () => {
	const payloads = captureMcpEvents(() => {
		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'search',
			failurePhase: 'handler',
			errorName: 'McpCallerError',
			errorMessage: 'Provide "query" or "domain".',
			cause: new McpCallerError('Provide "query" or "domain".'),
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'repo_open_session',
			failurePhase: 'handler',
			errorName: 'Error',
			errorMessage: 'Opening the session failed.',
			cause: new Error('Opening the session failed.', {
				cause: new McpCallerError('Discard the current session first.'),
			}),
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'value_get',
			failurePhase: 'parse_input',
			errorName: 'ZodError',
			errorMessage: 'name: Required',
			cause: new Error('name: Required'),
		})

		logMcpEvent({
			...callerFailureBase,
			tool: 'search',
			toolName: 'search',
			callerError: true,
			errorName: 'EntityBatchError',
			errorMessage: 'All entity lookups failed.',
		})
	})

	expect(payloads).toHaveLength(4)
	expect(sentryMock.captureException).not.toHaveBeenCalled()
	expect(sentryMock.captureMessage).not.toHaveBeenCalled()
})

test('logMcpEvent still reports platform failures that wrap no caller error', () => {
	captureMcpEvents(() => {
		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'package_get',
			failurePhase: 'handler',
			errorName: 'Error',
			errorMessage: 'D1 write failed.',
			cause: new Error('D1 write failed.', {
				cause: new Error('storage unavailable'),
			}),
		})
	})

	expect(sentryMock.captureException).toHaveBeenCalledTimes(1)
	expect(sentryMock.captureException).toHaveBeenCalledWith(
		expect.objectContaining({ message: 'D1 write failed.' }),
	)
})
