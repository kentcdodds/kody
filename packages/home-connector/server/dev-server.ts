process.env.NODE_ENV ??= 'development'
process.env.MOCKS ??= 'true'
process.env.ROKU_DISCOVERY_URL ??= 'http://roku.mock.local/discovery'

await import('./index.ts')
