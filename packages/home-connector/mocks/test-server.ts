import { setupServer } from 'msw/node'
import { mswHandlers } from './msw-handlers.ts'

export function installHomeConnectorMockServer() {
	const server = setupServer(...mswHandlers)
	server.listen()
	return server
}
