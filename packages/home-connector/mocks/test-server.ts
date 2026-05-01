import { setupServer } from 'msw/node'
import { mswHandlers } from './msw-handlers.ts'
import { resetMockJellyfishState } from './jellyfish.ts'
import { resetMockLutronSystem } from '../src/adapters/lutron/mock-driver.ts'
import { resetMockSonosState } from '../src/adapters/sonos/mock-driver.ts'
import { resetMockSamsungDevices } from '../src/adapters/samsung-tv/mock-driver.ts'
import { resetMockTeslaGatewayState } from '../src/adapters/tesla-gateway/mock-driver.ts'
import { resetMockVenstarState } from './venstar.ts'

let installedServer: ReturnType<typeof setupServer> | null = null

export function installHomeConnectorMockServer() {
	resetMockJellyfishState()
	resetMockLutronSystem()
	resetMockSonosState()
	resetMockSamsungDevices()
	resetMockVenstarState()
	resetMockTeslaGatewayState()
	if (installedServer) {
		return installedServer
	}

	installedServer = setupServer(...mswHandlers)
	installedServer.listen()
	return installedServer
}
