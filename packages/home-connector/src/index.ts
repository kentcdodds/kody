import { createHomeConnectorMcpServer } from './mcp/server.ts'
import { loadHomeConnectorConfig } from './config.ts'
import { createAppState, updateConnectionState } from './state.ts'
import { createWorkerConnector } from './transport/worker-connector.ts'

export function createHomeConnectorApp() {
	const config = loadHomeConnectorConfig()
	const state = createAppState()
	updateConnectionState(state, {
		workerUrl: config.workerBaseUrl,
		connectorId: config.homeConnectorId,
		sharedSecret: config.sharedSecret,
		mocksEnabled: config.mocksEnabled,
	})
	const mcp = createHomeConnectorMcpServer({
		config,
		state,
	})
	const workerConnector = createWorkerConnector({
		config,
		state,
		toolRegistry: mcp.createToolRegistry(),
	})

	return {
		config,
		state,
		mcp,
		workerConnector,
	}
}

export async function startHomeConnectorApp() {
	const app = createHomeConnectorApp()
	await app.workerConnector.start()
	return app
}
