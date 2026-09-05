import { expect, test } from 'vitest'
import {
	buildSsrSentryClientConfig,
	parseSentryClientConfig,
	SENTRY_TUNNEL_PATH,
} from '#universal/sentry-config.ts'

test('parseSentryClientConfig accepts complete configs and rejects unsafe tunnels', () => {
	expect(
		parseSentryClientConfig(
			JSON.stringify({
				dsn: 'https://key@o1.ingest.sentry.io/2',
				environment: 'production',
				release: 'abc123',
				tunnel: '/sentry-tunnel',
			}),
		),
	).toEqual({
		dsn: 'https://key@o1.ingest.sentry.io/2',
		environment: 'production',
		release: 'abc123',
		tunnel: '/sentry-tunnel',
	})

	expect(
		parseSentryClientConfig(
			JSON.stringify({
				dsn: 'https://key@o1.ingest.sentry.io/2',
				environment: 'preview',
				tunnel: '/sentry-tunnel',
			}),
		),
	).toMatchObject({ release: null })

	expect(parseSentryClientConfig(null)).toBeNull()
	expect(parseSentryClientConfig('')).toBeNull()
	expect(parseSentryClientConfig('not json')).toBeNull()
	expect(
		parseSentryClientConfig(
			JSON.stringify({ environment: 'production', tunnel: '/t' }),
		),
	).toBeNull()
	expect(
		parseSentryClientConfig(
			JSON.stringify({
				dsn: 'https://key@o1.ingest.sentry.io/2',
				environment: 'production',
				tunnel: 'https://evil.example.com/collect',
			}),
		),
	).toBeNull()
	// Scheme-relative URLs start with '/' but leave the origin.
	expect(
		parseSentryClientConfig(
			JSON.stringify({
				dsn: 'https://key@o1.ingest.sentry.io/2',
				environment: 'production',
				tunnel: '//evil.example.com/collect',
			}),
		),
	).toBeNull()
})

test('buildSsrSentryClientConfig skips local Vite and missing DSN, keeps deployed configs', () => {
	expect(
		buildSsrSentryClientConfig({
			dsn: 'https://key@o1.ingest.sentry.io/2',
			environment: 'production',
			release: 'abc123',
			localDev: true,
		}),
	).toBeNull()
	expect(
		buildSsrSentryClientConfig({
			dsn: '   ',
			environment: 'production',
		}),
	).toBeNull()
	expect(
		buildSsrSentryClientConfig({
			dsn: 'https://key@o1.ingest.sentry.io/2',
			environment: 'production',
			release: 'abc123',
		}),
	).toEqual({
		dsn: 'https://key@o1.ingest.sentry.io/2',
		environment: 'production',
		release: 'abc123',
		tunnel: SENTRY_TUNNEL_PATH,
	})
	expect(
		buildSsrSentryClientConfig({
			dsn: 'https://key@o1.ingest.sentry.io/2',
		}),
	).toEqual({
		dsn: 'https://key@o1.ingest.sentry.io/2',
		environment: 'development',
		release: null,
		tunnel: SENTRY_TUNNEL_PATH,
	})
})
