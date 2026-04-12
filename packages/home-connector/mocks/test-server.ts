import { setupServer } from 'msw/node'
import { mswHandlers } from './msw-handlers.ts'
import { resetMockLutronSystem } from '../src/adapters/lutron/mock-driver.ts'
import { resetMockSonosState } from '../src/adapters/sonos/mock-driver.ts'
import { resetMockSamsungDevices } from '../src/adapters/samsung-tv/mock-driver.ts'
import { resetMockVenstarState } from '../src/adapters/venstar/mock-driver.ts'

let installedServer: ReturnType<typeof setupServer> | null = null

export function installHomeConnectorMockServer() {
	resetMockLutronSystem()
	resetMockSonosState()
	resetMockSamsungDevices()
	resetMockVenstarState()
	if (installedServer) {
		return installedServer
	}

	installedServer = setupServer(...mswHandlers)
	installedServer.listen()
	return installedServer
}
