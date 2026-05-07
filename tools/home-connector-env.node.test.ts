import { expect, test } from 'vitest'
import { getForwardedHomeConnectorEnv } from './home-connector-env.ts'

test('forwards supported HOME_CONNECTOR_ vars and skips blank or unrelated values', () => {
	const forwarded = getForwardedHomeConnectorEnv({
		HOME_CONNECTOR_MOCKS: 'false',
		HOME_CONNECTOR_ROKU_DISCOVERY_URL: 'ssdp://239.255.255.250:1900',
		HOME_CONNECTOR_PORT: '5050',
		HOME_CONNECTOR_SONOS_DISCOVERY_URL: '   ',
		HOME_CONNECTOR_SENTRY_DSN: 'https://examplePublicKey@o0.ingest.sentry.io/0',
		HOME_CONNECTOR_SENTRY_ENVIRONMENT: 'preview',
		HOME_CONNECTOR_SENTRY_TRACES_SAMPLE_RATE: '0.25',
		HOME_CONNECTOR_APP_COMMIT_SHA: 'abc123',
		HOME_CONNECTOR_ID: 'living-room',
		HOME_CONNECTOR_SHARED_SECRET: 'super-secret',
		UNRELATED: 'ignored',
	})

	expect(forwarded).toEqual({
		APP_COMMIT_SHA: 'abc123',
		MOCKS: 'false',
		PORT: '5050',
		ROKU_DISCOVERY_URL: 'ssdp://239.255.255.250:1900',
		SENTRY_DSN: 'https://examplePublicKey@o0.ingest.sentry.io/0',
		SENTRY_ENVIRONMENT: 'preview',
		SENTRY_TRACES_SAMPLE_RATE: '0.25',
	})
})
