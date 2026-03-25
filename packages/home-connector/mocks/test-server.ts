import { setupServer } from 'msw/node'
import { mswHandlers } from './msw-handlers.ts'
import { resetMockSamsungDevices } from '../src/adapters/samsung-tv/mock-driver.ts'

let installedServer: ReturnType<typeof setupServer> | null = null

export function installHomeConnectorMockServer() {
	resetMockSamsungDevices()
	if (installedServer) {
		return installedServer
	}

	installedServer = setupServer(...mswHandlers)
	installedServer.listen()
	return installedServer
}
