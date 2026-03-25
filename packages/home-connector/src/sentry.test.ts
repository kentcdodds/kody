import { expect, test } from 'vitest'
import {
	buildHomeConnectorSentryOptions,
	initializeHomeConnectorSentry,
} from './sentry.ts'

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

test('buildHomeConnectorSentryOptions builds Bun Sentry options from env', () => {
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
	using _env = createTemporaryEnv({
		SENTRY_DSN: undefined,
		SENTRY_ENVIRONMENT: undefined,
		SENTRY_TRACES_SAMPLE_RATE: undefined,
		APP_COMMIT_SHA: undefined,
	})

	expect(() => initializeHomeConnectorSentry()).not.toThrow()
})
