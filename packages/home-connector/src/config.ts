export type HomeConnectorConfig = {
	homeConnectorId: string
	workerBaseUrl: string
	sharedSecret: string | null
	rokuDiscoveryUrl: string
	port: number
	mocksEnabled: boolean
}

export function loadHomeConnectorConfig(): HomeConnectorConfig {
	const port = Number.parseInt(process.env.PORT ?? '4040', 10)
	return {
		homeConnectorId: process.env.HOME_CONNECTOR_ID?.trim() || 'default',
		workerBaseUrl:
			process.env.WORKER_BASE_URL?.trim() || 'http://localhost:3742',
		sharedSecret: process.env.HOME_CONNECTOR_SHARED_SECRET?.trim() || null,
		rokuDiscoveryUrl:
			process.env.ROKU_DISCOVERY_URL?.trim() || 'http://roku.mock.local',
		port: Number.isFinite(port) ? port : 4040,
		mocksEnabled: process.env.MOCKS === 'true',
	}
}
