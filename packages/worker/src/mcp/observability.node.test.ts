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

test('logMcpEvent keeps sandbox failures on mcp-event logs and skips Sentry', () => {
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
			category: 'mcp',
			tool: 'capability',
			capabilityName: 'value_get',
			capabilitySource: 'builtin',
			outcome: 'failure',
			durationMs: 3,
			baseUrl: 'https://example.com',
			hasUser: true,
			userId: 'user-1',
			sandboxError: false,
			failurePhase: 'handler',
			errorName: 'Error',
			errorMessage: 'platform handler blew up',
			cause: new Error('platform handler blew up'),
		})
	} finally {
		console.info = originalInfo
	}

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
