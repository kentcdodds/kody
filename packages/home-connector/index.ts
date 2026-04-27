import 'dotenv/config'
import { initializeHomeConnectorSentry } from './src/sentry.ts'

// `--import ./src/sentry-init.ts` can run before `dotenv/config`, so initialize
// again after env-file loading to pick up `.env`-only DSNs.
initializeHomeConnectorSentry()

if (process.env.MOCKS === 'true') {
	await import('./mocks/index.ts')
}

if (process.env.NODE_ENV === 'production') {
	await import('./server/index.ts')
} else {
	await import('./server/dev-server.ts')
}
