import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../mocks/test-server.ts'
import { createLutronAdapter } from '../src/adapters/lutron/index.ts'
import { createSamsungTvAdapter } from '../src/adapters/samsung-tv/index.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { createAppState } from '../src/state.ts'
import { createHomeConnectorStorage } from '../src/storage/index.ts'
import { createHomeConnectorRouter } from './router.ts'

function createConfig(): HomeConnectorConfig {
	return {
		homeConnectorId: 'default',
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/home/connectors/default',
		workerWebSocketUrl: 'ws://localhost:3742/home/connectors/default',
		sharedSecret: 'secret',
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		dataPath: '/tmp',
		dbPath: ':memory:',
		port: 4040,
		mocksEnabled: true,
	}
}

function createAdapters(config: HomeConnectorConfig) {
	const storage = createHomeConnectorStorage(config)
	const state = createAppState()
	return {
		state,
		storage,
		lutron: createLutronAdapter({
			config,
			state,
			storage,
		}),
		samsungTv: createSamsungTvAdapter({
			config,
			state,
			storage,
		}),
	}
}

installHomeConnectorMockServer()

test('home route renders admin dashboard links and connection info', async () => {
	const config = createConfig()
	const { state, storage, lutron, samsungTv } = createAdapters(config)
	state.connection.connectorId = 'default'
	state.connection.workerUrl = 'http://localhost:3742'
	state.connection.connected = true
	state.connection.sharedSecret = 'secret'
	try {
		const router = createHomeConnectorRouter(state, config, lutron, samsungTv)
		const response = await router.fetch('http://example.test/')
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('Home connector admin')
		expect(html).toContain('/roku/status')
		expect(html).toContain('/roku/setup')
		expect(html).toContain('/lutron/status')
		expect(html).toContain('/lutron/setup')
		expect(html).toContain('/samsung-tv/status')
		expect(html).toContain('/samsung-tv/setup')
		expect(html).toContain('/home/connectors/default/snapshot')
		expect(html).toContain('connected')
	} finally {
		storage.close()
	}
})

test('health route returns ok json', async () => {
	const config = createConfig()
	const { state, storage, lutron, samsungTv } = createAdapters(config)
	try {
		const router = createHomeConnectorRouter(state, config, lutron, samsungTv)
		const response = await router.fetch('http://example.test/health')
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			ok: true,
			service: 'home-connector',
			connectorId: '',
		})
	} finally {
		storage.close()
	}
})

test('roku status route renders connector details', async () => {
	const config = createConfig()
	const { state, storage, lutron, samsungTv } = createAdapters(config)
	state.connection.connectorId = 'default'
	state.connection.workerUrl = 'http://localhost:3742'
	state.connection.connected = true
	state.connection.lastSyncAt = '2026-03-24T12:00:00.000Z'
	try {
		const router = createHomeConnectorRouter(state, config, lutron, samsungTv)
		const response = await router.fetch('http://example.test/roku/status')
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('Roku status')
		expect(html).toContain('Scan now')
		expect(html).toContain('connected')
		expect(html).toContain('default')
	} finally {
		storage.close()
	}
})

test('roku status route renders last discovery diagnostics', async () => {
	const config = createConfig()
	const { state, storage, lutron, samsungTv } = createAdapters(config)
	state.rokuDiscoveryDiagnostics = {
		protocol: 'ssdp',
		discoveryUrl: 'ssdp://239.255.255.250:1900',
		scannedAt: '2026-03-24T12:00:00.000Z',
		jsonResponse: null,
		ssdpHits: [
			{
				receivedAt: '2026-03-24T12:00:00.000Z',
				remoteAddress: '192.168.1.45',
				remotePort: 1900,
				raw: 'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.45:8060/\r\n',
				location: 'http://192.168.1.45:8060/',
				usn: 'uuid:roku:ecp:YH00AA123456',
				server: 'Roku/14.0.0 UPnP/1.0 Roku-ECP/1.0',
			},
		],
		deviceInfoLookups: [
			{
				location: 'http://192.168.1.45:8060/',
				deviceInfoUrl: 'http://192.168.1.45:8060/query/device-info',
				raw: '<device-info><serial-number>YH00AA123456</serial-number></device-info>',
				parsed: {
					name: 'Living Room Roku',
					serialNumber: 'YH00AA123456',
					modelName: 'Roku Ultra',
				},
				error: null,
			},
		],
	}
	try {
		const router = createHomeConnectorRouter(state, config, lutron, samsungTv)
		const response = await router.fetch('http://example.test/roku/status')
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('Discovery diagnostics')
		expect(html).toContain('Raw SSDP hits')
		expect(html).toContain('192.168.1.45:1900')
		expect(html).toContain('http://192.168.1.45:8060/query/device-info')
		expect(html).toContain('YH00AA123456')
	} finally {
		storage.close()
	}
})

test('roku status route can run a manual scan', async () => {
	const config = createConfig()
	const { state, storage, lutron, samsungTv } = createAdapters(config)
	try {
		const router = createHomeConnectorRouter(state, config, lutron, samsungTv)
		const response = await router.fetch(
			new Request('http://example.test/roku/status', {
				method: 'POST',
			}),
		)
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('Scan complete. Discovered 2 Roku device(s).')
		expect(html).toContain('Living Room Roku')
		expect(html).toContain('Bedroom Roku')
	} finally {
		storage.close()
	}
})

test('roku setup route reports missing shared secret clearly', async () => {
	const config = createConfig()
	const { state, storage, lutron, samsungTv } = createAdapters(config)
	state.connection.connectorId = 'default'
	state.connection.workerUrl = 'http://localhost:3742'
	state.connection.sharedSecret = null
	state.connection.mocksEnabled = true
	try {
		const router = createHomeConnectorRouter(state, config, lutron, samsungTv)
		const response = await router.fetch('http://example.test/roku/setup')
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('Shared secret is missing.')
		expect(html).toContain('Mocks are enabled')
	} finally {
		storage.close()
	}
})

test('lutron status route can run a manual scan', async () => {
	const config = createConfig()
	const { state, storage, lutron, samsungTv } = createAdapters(config)
	try {
		const router = createHomeConnectorRouter(state, config, lutron, samsungTv)
		const response = await router.fetch(
			new Request('http://example.test/lutron/status', {
				method: 'POST',
			}),
		)
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('Lutron status')
		expect(html).toContain('Scan complete. Discovered 2 Lutron processor(s).')
		expect(html).toContain('Primary Processor')
		expect(html).toContain('Wireless Processor')
	} finally {
		storage.close()
	}
})
