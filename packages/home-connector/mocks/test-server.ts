import { setupServer } from 'msw/node'
import { mswHandlers } from './msw-handlers.ts'

let installedServer: ReturnType<typeof setupServer> | null = null

export function installHomeConnectorMockServer() {
	if (installedServer) {
		return installedServer
	}

	installedServer = setupServer(...mswHandlers)
	installedServer.listen()
	return installedServer
}
