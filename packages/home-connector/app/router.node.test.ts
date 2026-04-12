import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../mocks/test-server.ts'
import { createBondAdapter } from '../src/adapters/bond/index.ts'
import { createLutronAdapter } from '../src/adapters/lutron/index.ts'
import { createSamsungTvAdapter } from '../src/adapters/samsung-tv/index.ts'
import { createSonosAdapter } from '../src/adapters/sonos/index.ts'
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
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
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
		sonos: createSonosAdapter({
			config,
			state,
			storage,
		}),
		samsungTv: createSamsungTvAdapter({
			config,
			state,
			storage,
		}),
		bond: createBondAdapter({
			config,
			state,
			storage,
		}),
	}
}

installHomeConnectorMockServer()

test('home route toggles worker snapshot link by connector id', async () => {
	const config = createConfig()
	const { state, storage, lutron, sonos, samsungTv, bond } =
		createAdapters(config)
	state.connection.connectorId = 'default'
	state.connection.workerUrl = 'http://localhost:3742'
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
		)
		const responseWithConnector = await router.fetch('http://example.test/')
		expect(responseWithConnector.status).toBe(200)
		const htmlWithConnector = await responseWithConnector.text()
		expect(htmlWithConnector).toContain('Home connector admin')
		expect(htmlWithConnector).toContain('/home/connectors/default/snapshot')

		state.connection.connectorId = ''
		const responseWithoutConnector = await router.fetch('http://example.test/')
		expect(responseWithoutConnector.status).toBe(200)
		const htmlWithoutConnector = await responseWithoutConnector.text()
		expect(htmlWithoutConnector).toContain('Home connector admin')
		expect(htmlWithoutConnector).not.toContain('Worker connector snapshot')
	} finally {
		storage.close()
	}
})

test('bond setup route renders token form', async () => {
	const config = createConfig()
	const { state, storage, lutron, sonos, samsungTv, bond } =
		createAdapters(config)
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
		)
		const response = await router.fetch('http://example.test/bond/setup')
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('Save pasted token')
		expect(html).toContain('Retrieve token from bridge')
	} finally {
		storage.close()
	}
})

test('health route returns ok json', async () => {
	const config = createConfig()
	const { state, storage, lutron, sonos, samsungTv, bond } =
		createAdapters(config)
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
		)
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
