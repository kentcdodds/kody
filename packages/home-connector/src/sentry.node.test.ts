import { afterEach, expect, test, vi } from 'vitest'

const sentryMock = vi.hoisted(() => ({
	addBreadcrumb: vi.fn(),
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	close: vi.fn(),
	flush: vi.fn(),
	init: vi.fn(),
	isEnabled: vi.fn(() => false),
	setContext: vi.fn(),
	setTag: vi.fn(),
}))

vi.mock('@sentry/node', () => sentryMock)

afterEach(() => {
	sentryMock.isEnabled.mockReturnValue(false)
})

const {
	buildHomeConnectorSentryOptions,
	addHomeConnectorSentryBreadcrumb,
	captureHomeConnectorException,
	closeHomeConnectorSentry,
	flushHomeConnectorSentry,
	getHomeConnectorErrorCaptureContext,
	initializeHomeConnectorSentry,
} = await import('./sentry.ts')

function createTemporaryEnv(values: Record<string, string | undefined>) {
	const previousValues = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	)

	for (const [key, value] of Object.entries(values)) {
		if (typeof value === 'undefined') {
			delete process.env[key]
			continue
		}

		process.env[key] = value
	}

	return {
		[Symbol.dispose]: () => {
			for (const [key, value] of Object.entries(previousValues)) {
				if (typeof value === 'undefined') {
					delete process.env[key]
					continue
				}

				process.env[key] = value
			}
		},
	}
}

test('buildHomeConnectorSentryOptions returns undefined without a DSN', () => {
	expect(
		buildHomeConnectorSentryOptions({
			SENTRY_DSN: undefined,
		}),
	).toBeUndefined()
})

test('buildHomeConnectorSentryOptions builds Node Sentry options from env', () => {
	const options = buildHomeConnectorSentryOptions({
		SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
		SENTRY_ENVIRONMENT: 'preview',
		SENTRY_TRACES_SAMPLE_RATE: '0.25',
		APP_COMMIT_SHA: 'abc123',
	})

	expect(options).toEqual({
		dsn: 'https://public@example.ingest.sentry.io/1',
		environment: 'preview',
		release: 'abc123',
		tracesSampleRate: 0.25,
		sendDefaultPii: false,
	})
})

test('buildHomeConnectorSentryOptions falls back to defaults for invalid sample rates', () => {
	const options = buildHomeConnectorSentryOptions({
		SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
		SENTRY_TRACES_SAMPLE_RATE: 'nope',
		NODE_ENV: 'production',
	})

	expect(options).toEqual({
		dsn: 'https://public@example.ingest.sentry.io/1',
		environment: 'production',
		tracesSampleRate: 1,
		sendDefaultPii: false,
	})
})

test('initializeHomeConnectorSentry skips initialization without a DSN', () => {
	sentryMock.isEnabled.mockReturnValue(false)
	using _env = createTemporaryEnv({
		SENTRY_DSN: undefined,
		SENTRY_ENVIRONMENT: undefined,
		SENTRY_TRACES_SAMPLE_RATE: undefined,
		APP_COMMIT_SHA: undefined,
	})

	expect(() => initializeHomeConnectorSentry()).not.toThrow()
})

test('flushHomeConnectorSentry returns true when Sentry is disabled', async () => {
	sentryMock.isEnabled.mockReturnValue(false)
	sentryMock.flush.mockReset()
	await expect(flushHomeConnectorSentry()).resolves.toBe(true)
	expect(sentryMock.flush).not.toHaveBeenCalled()
})

test('closeHomeConnectorSentry returns true when Sentry is disabled', async () => {
	sentryMock.isEnabled.mockReturnValue(false)
	sentryMock.close.mockReset()
	await expect(closeHomeConnectorSentry()).resolves.toBe(true)
	expect(sentryMock.close).not.toHaveBeenCalled()
})

test('addHomeConnectorSentryBreadcrumb is a no-op when Sentry is disabled', () => {
	sentryMock.isEnabled.mockReturnValue(false)
	sentryMock.addBreadcrumb.mockReset()

	addHomeConnectorSentryBreadcrumb({
		message: 'Opening home connector websocket.',
		category: 'websocket.lifecycle',
	})

	expect(sentryMock.addBreadcrumb).not.toHaveBeenCalled()
})

test('getHomeConnectorErrorCaptureContext returns a cloned capture context', () => {
	const error = new Error('boom') as Error & {
		homeConnectorCaptureContext?: {
			tags?: Record<string, string>
			contexts?: Record<string, Record<string, unknown>>
			extra?: Record<string, unknown>
		}
	}
	error.homeConnectorCaptureContext = {
		tags: {
			connector_family: 'bond',
		},
		contexts: {
			bond: {
				bridgeId: 'bond-1',
			},
		},
		extra: {
			durationMs: 48,
		},
	}

	const captureContext = getHomeConnectorErrorCaptureContext(error)
	expect(captureContext).toEqual({
		tags: {
			connector_family: 'bond',
		},
		contexts: {
			bond: {
				bridgeId: 'bond-1',
			},
		},
		extra: {
			durationMs: 48,
		},
	})
	expect(captureContext.tags).not.toBe(error.homeConnectorCaptureContext.tags)
	expect(captureContext.contexts).not.toBe(
		error.homeConnectorCaptureContext.contexts,
	)
	expect(captureContext.contexts?.bond).not.toBe(
		error.homeConnectorCaptureContext.contexts?.bond,
	)
	expect(captureContext.extra).not.toBe(error.homeConnectorCaptureContext.extra)
})

test('captureHomeConnectorException merges error capture context', () => {
	sentryMock.isEnabled.mockReturnValue(true)
	sentryMock.captureException.mockReset()
	const error = new Error('boom') as Error & {
		homeConnectorCaptureContext?: {
			tags?: Record<string, string>
			contexts?: Record<string, Record<string, unknown>>
			extra?: Record<string, unknown>
		}
	}
	error.homeConnectorCaptureContext = {
		tags: {
			connector_family: 'bond',
			connector_tool_name: 'bond_get_device_state',
		},
		contexts: {
			bond: {
				bridgeId: 'bond-1',
				host: 'bridge.local',
			},
		},
		extra: {
			requestId: 'abc123',
		},
	}

	captureHomeConnectorException(error, {
		tags: {
			connector_event: 'tool_call.failure',
		},
		contexts: {
			mcp_request: {
				method: 'tools/call',
			},
		},
		extra: {
			durationMs: 48,
		},
	})

	expect(sentryMock.captureException).toHaveBeenCalledTimes(1)
	const [capturedError, captureContext] =
		sentryMock.captureException.mock.calls[0] ?? []
	expect(capturedError).toBe(error)
	expect(captureContext).toEqual({
		tags: {
			service: 'home-connector',
			connector_family: 'bond',
			connector_tool_name: 'bond_get_device_state',
			connector_event: 'tool_call.failure',
		},
		contexts: {
			bond: {
				bridgeId: 'bond-1',
				host: 'bridge.local',
			},
			mcp_request: {
				method: 'tools/call',
			},
		},
		extra: {
			requestId: 'abc123',
			durationMs: 48,
		},
	})
})
