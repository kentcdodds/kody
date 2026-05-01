import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../mocks/test-server.ts'
import { createBondAdapter } from '../src/adapters/bond/index.ts'
import { createJellyfishAdapter } from '../src/adapters/jellyfish/index.ts'
import { createLutronAdapter } from '../src/adapters/lutron/index.ts'
import { createSamsungTvAdapter } from '../src/adapters/samsung-tv/index.ts'
import { createSonosAdapter } from '../src/adapters/sonos/index.ts'
import { createTeslaGatewayAdapter } from '../src/adapters/tesla-gateway/index.ts'
import { createVenstarAdapter } from '../src/adapters/venstar/index.ts'
import { upsertVenstarThermostat } from '../src/adapters/venstar/repository.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { createAppState } from '../src/state.ts'
import { createHomeConnectorStorage } from '../src/storage/index.ts'
import { createHomeConnectorRouter } from './router.ts'

function createConfig(dataPath = '/tmp'): HomeConnectorConfig {
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
		jellyfishDiscoveryUrl: 'http://jellyfish.mock.local/discovery',
		venstarScanCidrs: ['192.168.10.40/32', '192.168.10.41/32'],
		jellyfishScanCidrs: ['192.168.10.93/32'],
		teslaGatewayScanCidrs: [],
		teslaGatewayDiscoveryUrl: null,
		dataPath,
		dbPath: ':memory:',
		port: 4040,
		mocksEnabled: true,
	}
}

function createAdapters(config: HomeConnectorConfig) {
	const storage = createHomeConnectorStorage(config)
	upsertVenstarThermostat({
		storage,
		connectorId: config.homeConnectorId,
		name: 'Hallway',
		ip: 'venstar.mock.local',
	})
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
		jellyfish: createJellyfishAdapter({
			config,
			state,
			storage,
		}),
		venstar: createVenstarAdapter({ config, state, storage }),
		teslaGateway: createTeslaGatewayAdapter({ config, state, storage }),
	}
}

installHomeConnectorMockServer()

function createTemporaryDataPath() {
	return mkdtempSync(path.join(tmpdir(), 'kody-home-connector-venstar-'))
}

test('home route toggles worker snapshot link by connector id', async () => {
	const config = createConfig()
	const {
		state,
		storage,
		lutron,
		sonos,
		samsungTv,
		bond,
		jellyfish,
		venstar,
		teslaGateway,
	} = createAdapters(config)
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
			jellyfish,
			venstar,
			teslaGateway,
		)
		const responseWithConnector = await router.fetch('http://example.test/')
		expect(responseWithConnector.status).toBe(200)
		const htmlWithConnector = await responseWithConnector.text()
		expect(htmlWithConnector).toContain('/home/connectors/default/snapshot')

		state.connection.connectorId = ''
		const responseWithoutConnector = await router.fetch('http://example.test/')
		expect(responseWithoutConnector.status).toBe(200)
		const htmlWithoutConnector = await responseWithoutConnector.text()
		expect(htmlWithoutConnector).not.toContain(
			'/home/connectors/default/snapshot',
		)
	} finally {
		storage.close()
	}
})

test('venstar status scan shows discovered thermostats', async () => {
	const config = createConfig()
	const {
		state,
		storage,
		lutron,
		sonos,
		samsungTv,
		bond,
		jellyfish,
		venstar,
		teslaGateway,
	} = createAdapters(config)
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			jellyfish,
			venstar,
			teslaGateway,
		)
		const response = await router.fetch('http://example.test/venstar/status', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: 'action=scan',
		})
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('Office')
		expect(html).toContain('192.168.10.41')
		expect(venstar.listThermostats()).toMatchObject([
			{
				name: 'Hallway',
				ip: 'venstar.mock.local',
			},
		])
	} finally {
		storage.close()
	}
})

test('venstar status can adopt a discovered thermostat', async () => {
	const dataPath = createTemporaryDataPath()
	const config = createConfig(dataPath)
	const {
		state,
		storage,
		lutron,
		sonos,
		samsungTv,
		bond,
		jellyfish,
		venstar,
		teslaGateway,
	} = createAdapters(config)
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			jellyfish,
			venstar,
			teslaGateway,
		)

		await router.fetch('http://example.test/venstar/status', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: 'action=scan',
		})

		const response = await router.fetch('http://example.test/venstar/status', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				action: 'adopt-discovered',
				thermostatName: 'Office',
				thermostatIp: '192.168.10.41',
			}).toString(),
		})

		expect(response.status).toBe(200)
		await response.text()
		expect(venstar.listThermostats()).toMatchObject([
			{
				name: 'Hallway',
				ip: 'venstar.mock.local',
				lastSeenAt: expect.any(String),
			},
			{
				name: 'Office',
				ip: '192.168.10.41',
				lastSeenAt: expect.any(String),
			},
		])
	} finally {
		storage.close()
		rmSync(dataPath, { recursive: true, force: true })
	}
})

test('venstar setup can save and remove thermostats directly', async () => {
	const dataPath = createTemporaryDataPath()
	const config = createConfig(dataPath)
	const {
		state,
		storage,
		lutron,
		sonos,
		samsungTv,
		bond,
		jellyfish,
		venstar,
		teslaGateway,
	} = createAdapters(config)
	try {
		venstar.removeThermostat('venstar.mock.local')
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			jellyfish,
			venstar,
			teslaGateway,
		)

		const saveResponse = await router.fetch(
			'http://example.test/venstar/setup',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					action: 'save-manual',
					thermostatName: 'UPSTAIRS',
					thermostatIp: '192.168.0.71',
				}).toString(),
			},
		)
		expect(saveResponse.status).toBe(200)
		await saveResponse.text()
		expect(venstar.listThermostats()).toEqual([
			{ name: 'UPSTAIRS', ip: '192.168.0.71', lastSeenAt: null },
		])

		const removeResponse = await router.fetch(
			'http://example.test/venstar/setup',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					action: 'remove-configured',
					thermostatIp: '192.168.0.71',
				}).toString(),
			},
		)
		expect(removeResponse.status).toBe(200)
		await removeResponse.text()
		expect(venstar.listThermostats()).toEqual([])
	} finally {
		storage.close()
		rmSync(dataPath, { recursive: true, force: true })
	}
})

test('health route returns ok json', async () => {
	const config = createConfig()
	const {
		state,
		storage,
		lutron,
		sonos,
		samsungTv,
		bond,
		jellyfish,
		venstar,
		teslaGateway,
	} = createAdapters(config)
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			jellyfish,
			venstar,
			teslaGateway,
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
