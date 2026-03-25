import { homedir } from 'node:os'
import path from 'node:path'

export type HomeConnectorConfig = {
	homeConnectorId: string
	workerBaseUrl: string
	workerSessionUrl: string
	workerWebSocketUrl: string
	sharedSecret: string | null
	rokuDiscoveryUrl: string
	samsungTvDiscoveryUrl: string
	dataPath: string
	dbPath: string
	port: number
	mocksEnabled: boolean
}

function trimTrailingSlash(value: string) {
	return value.endsWith('/') ? value.slice(0, -1) : value
}

function createWorkerSessionUrl(
	workerBaseUrl: string,
	homeConnectorId: string,
) {
	const url = new URL(
		`/home/connectors/${encodeURIComponent(homeConnectorId)}`,
		`${trimTrailingSlash(workerBaseUrl)}/`,
	)
	return url.toString()
}

function createWorkerWebSocketUrl(workerSessionUrl: string) {
	const url = new URL(workerSessionUrl)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	return url.toString()
}

function resolveHomeConnectorDataPath() {
	return (
		process.env.HOME_CONNECTOR_DATA_PATH?.trim() ||
		path.join(homedir(), '.kody', 'home-connector')
	)
}

function resolveHomeConnectorDbPath(dataPath: string) {
	return (
		process.env.HOME_CONNECTOR_DB_PATH?.trim() ||
		path.join(dataPath, 'home-connector.sqlite')
	)
}

export function loadHomeConnectorConfig(): HomeConnectorConfig {
	const port = Number.parseInt(process.env.PORT ?? '4040', 10)
	const homeConnectorId = process.env.HOME_CONNECTOR_ID?.trim() || 'default'
	const workerBaseUrl =
		process.env.WORKER_BASE_URL?.trim() || 'http://localhost:3742'
	const mocksEnabled = process.env.MOCKS === 'true'
	const dataPath = resolveHomeConnectorDataPath()
	const workerSessionUrl = createWorkerSessionUrl(
		workerBaseUrl,
		homeConnectorId,
	)
	return {
		homeConnectorId,
		workerBaseUrl,
		workerSessionUrl,
		workerWebSocketUrl: createWorkerWebSocketUrl(workerSessionUrl),
		sharedSecret: process.env.HOME_CONNECTOR_SHARED_SECRET?.trim() || null,
		rokuDiscoveryUrl:
			process.env.ROKU_DISCOVERY_URL?.trim() || 'ssdp://239.255.255.250:1900',
		samsungTvDiscoveryUrl:
			process.env.SAMSUNG_TV_DISCOVERY_URL?.trim() ||
			'mdns://_samsungmsf._tcp.local',
		dataPath,
		dbPath: resolveHomeConnectorDbPath(dataPath),
		port: Number.isFinite(port) ? port : 4040,
		mocksEnabled,
	}
}
