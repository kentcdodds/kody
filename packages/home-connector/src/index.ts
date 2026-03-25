import { createSamsungTvAdapter } from './adapters/samsung-tv/index.ts'
import { createHomeConnectorMcpServer } from './mcp/server.ts'
import { loadHomeConnectorConfig } from './config.ts'
import { createAppState, updateConnectionState } from './state.ts'
import { createHomeConnectorStorage } from './storage/index.ts'
import { createWorkerConnector } from './transport/worker-connector.ts'

export function createHomeConnectorApp() {
	const config = loadHomeConnectorConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	updateConnectionState(state, {
		workerUrl: config.workerBaseUrl,
		connectorId: config.homeConnectorId,
		sharedSecret: config.sharedSecret,
		mocksEnabled: config.mocksEnabled,
	})
	const samsungTv = createSamsungTvAdapter({
		config,
		state,
		storage,
	})
	const mcp = createHomeConnectorMcpServer({
		config,
		state,
		samsungTv,
	})
	const workerConnector = createWorkerConnector({
		config,
		state,
		toolRegistry: mcp.createToolRegistry(),
	})

	return {
		config,
		state,
		storage,
		samsungTv,
		mcp,
		workerConnector,
	}
}

export async function startHomeConnectorApp() {
	const app = createHomeConnectorApp()
	await app.workerConnector.start()
	return app
}
