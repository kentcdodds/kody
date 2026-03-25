import { setupServer } from 'msw/node'
import { mswHandlers } from './msw-handlers.ts'

const server = setupServer(...mswHandlers)

server.listen({
	onUnhandledRequest(request, print) {
		if (
			request.url.includes('.sentry.io') ||
			request.url.includes('/__mocks/')
		) {
			return
		}

		print.warning()
	},
})

console.info('Mock server installed for home connector')

process.once('SIGINT', () => server.close())
process.once('SIGTERM', () => server.close())
