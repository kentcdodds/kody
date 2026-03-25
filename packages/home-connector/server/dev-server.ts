process.env.NODE_ENV ??= 'development'
process.env.MOCKS ??= 'true'
process.env.ROKU_DISCOVERY_URL ??= 'http://roku.mock.local/discovery'

await import('../src/sentry-init.ts')
const { captureHomeConnectorException, flushHomeConnectorSentry } = await import(
	'../src/sentry.ts'
)

try {
	await import('./index.ts')
} catch (error) {
	captureHomeConnectorException(error, {
		tags: {
			area: 'startup',
			mode: 'development',
		},
	})
	await flushHomeConnectorSentry()
	throw error
}
