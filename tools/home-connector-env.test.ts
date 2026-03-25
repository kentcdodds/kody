import { expect, test } from 'vitest'
import { getForwardedHomeConnectorEnv } from './home-connector-env.ts'

test('forwards HOME_CONNECTOR_ env vars to connector child names', () => {
	const forwarded = getForwardedHomeConnectorEnv({
		HOME_CONNECTOR_MOCKS: 'false',
		HOME_CONNECTOR_ROKU_DISCOVERY_URL: 'ssdp://239.255.255.250:1900',
		HOME_CONNECTOR_PORT: '5050',
		HOME_CONNECTOR_ID: 'living-room',
		HOME_CONNECTOR_SHARED_SECRET: 'super-secret',
		UNRELATED: 'ignored',
	})

	expect(forwarded).toEqual({
		MOCKS: 'false',
		ROKU_DISCOVERY_URL: 'ssdp://239.255.255.250:1900',
		PORT: '5050',
	})
})

test('ignores blank forwarded values', () => {
	const forwarded = getForwardedHomeConnectorEnv({
		HOME_CONNECTOR_MOCKS: '   ',
		HOME_CONNECTOR_ROKU_DISCOVERY_URL: undefined,
	})

	expect(forwarded).toEqual({})
})

test('forwards connector Sentry env vars', () => {
	const forwarded = getForwardedHomeConnectorEnv({
		HOME_CONNECTOR_SENTRY_DSN: 'https://examplePublicKey@o0.ingest.sentry.io/0',
		HOME_CONNECTOR_SENTRY_ENVIRONMENT: 'preview',
		HOME_CONNECTOR_SENTRY_TRACES_SAMPLE_RATE: '0.25',
		HOME_CONNECTOR_APP_COMMIT_SHA: 'abc123',
	})

	expect(forwarded).toEqual({
		SENTRY_DSN: 'https://examplePublicKey@o0.ingest.sentry.io/0',
		SENTRY_ENVIRONMENT: 'preview',
		SENTRY_TRACES_SAMPLE_RATE: '0.25',
		APP_COMMIT_SHA: 'abc123',
	})
})
