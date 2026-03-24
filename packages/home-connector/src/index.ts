import { createHomeConnectorMcpServer } from './mcp/server.ts'
import { createWorkerConnector } from './transport/worker-connector.ts'
import { getHomeConnectorConfig } from './config.ts'
import { initializeConnectorState } from './state.ts'

export function createHomeConnectorApp() {
	const config = getHomeConnectorConfig()
	const state = initializeConnectorState(config)
	const mcp = createHomeConnectorMcpServer({
		config,
		state,
	})
	const workerConnector = createWorkerConnector({
		config,
		mcp,
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
