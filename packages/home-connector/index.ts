import 'dotenv/config'

if (process.env.MOCKS === 'true') {
	await import('./mocks/index.ts')
}

if (process.env.NODE_ENV === 'production') {
	await import('./server/index.ts')
} else {
	await import('./server/dev-server.ts')
}
