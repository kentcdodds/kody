process.env.NODE_ENV ??= 'development'
process.env.MOCKS ??= 'true'
process.env.ROKU_DISCOVERY_URL ??= 'http://roku.mock.local/discovery'
process.env.LUTRON_DISCOVERY_URL ??= 'http://lutron.mock.local/discovery'
process.env.SAMSUNG_TV_DISCOVERY_URL ??=
	'http://samsung-tv.mock.local/discovery'

await import('../src/sentry-init.ts')
await import('./index.ts')
