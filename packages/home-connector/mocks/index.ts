import { setupServer } from 'msw/node'
import { mswHandlers } from './msw-handlers.ts'
import { resetMockBondState } from './bond.ts'
import { resetMockLutronSystem } from '../src/adapters/lutron/mock-driver.ts'
import { resetMockSonosState } from '../src/adapters/sonos/mock-driver.ts'
import { resetMockSamsungDevices } from '../src/adapters/samsung-tv/mock-driver.ts'
import { resetMockVenstarState } from './venstar.ts'

resetMockLutronSystem()
resetMockSonosState()
resetMockSamsungDevices()
resetMockBondState()
resetMockVenstarState()
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
