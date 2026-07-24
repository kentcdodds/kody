import { expect, test } from 'vitest'
import { parseSentryClientConfig } from './sentry-config.ts'

test('parses a complete config and normalizes missing release to null', () => {
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
})

test('rejects missing, malformed, or non-same-origin-tunnel configs', () => {
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
