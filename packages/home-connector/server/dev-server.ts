process.env.NODE_ENV ??= 'development'
process.env.MOCKS ??= 'true'

await import('./index.ts')
