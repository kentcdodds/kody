import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../mocks/test-server.ts'
import { createBondAdapter } from '../src/adapters/bond/index.ts'
import { createAccessNetworksUnleashedAdapter } from '../src/adapters/access-networks-unleashed/index.ts'
import { createIslandRouterApiAdapter } from '../src/adapters/island-router-api/index.ts'
import { createIslandRouterAdapter } from '../src/adapters/island-router/index.ts'
import { createJellyfishAdapter } from '../src/adapters/jellyfish/index.ts'
import { createLutronAdapter } from '../src/adapters/lutron/index.ts'
import { createSamsungTvAdapter } from '../src/adapters/samsung-tv/index.ts'
import { createSonosAdapter } from '../src/adapters/sonos/index.ts'
import { upsertDiscoveredAccessNetworksUnleashedControllers } from '../src/adapters/access-networks-unleashed/repository.ts'
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
		islandRouterHost: null,
		islandRouterPort: 22,
		islandRouterUsername: null,
		islandRouterPrivateKeyPath: null,
		islandRouterKnownHostsPath: null,
		islandRouterHostFingerprint: null,
		islandRouterCommandTimeoutMs: 8000,
		islandRouterApiBaseUrl: 'https://my.islandrouter.com',
		islandRouterApiRequestTimeoutMs: 8000,
		islandRouterApiAllowInsecureTls: false,
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		accessNetworksUnleashedScanCidrs: ['192.168.1.10/32'],
		accessNetworksUnleashedAllowInsecureTls: true,
		accessNetworksUnleashedRequestTimeoutMs: 8_000,
		bondRequestPaceMs: 0,
		bondCircuitBreakerCooldownMs: 0,
		jellyfishDiscoveryUrl: 'http://jellyfish.mock.local/discovery',
		venstarScanCidrs: ['192.168.10.40/32', '192.168.10.41/32'],
		jellyfishScanCidrs: ['192.168.10.93/32'],
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
		accessNetworksUnleashed: createAccessNetworksUnleashedAdapter({
			config,
			state,
			storage,
		}),
		islandRouter: createIslandRouterAdapter({
			config,
		}),
		islandRouterApi: createIslandRouterApiAdapter({
			config,
			storage,
		}),
		jellyfish: createJellyfishAdapter({
			config,
			state,
			storage,
		}),
		venstar: createVenstarAdapter({ config, state, storage }),
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
		accessNetworksUnleashed,
		islandRouter,
		islandRouterApi,
		jellyfish,
		venstar,
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
			accessNetworksUnleashed,
			islandRouter,
			islandRouterApi,
			jellyfish,
			venstar,
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
		expect(htmlWithConnector).toContain('Home connector dashboard')
		expect(htmlWithConnector).toContain('Island router diagnostics')
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
		accessNetworksUnleashed,
		islandRouter,
		islandRouterApi,
		jellyfish,
		venstar,
	} = createAdapters(config)
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			accessNetworksUnleashed,
			islandRouter,
			islandRouterApi,
			jellyfish,
			venstar,
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
		accessNetworksUnleashed,
		islandRouter,
		islandRouterApi,
		jellyfish,
		venstar,
	} = createAdapters(config)
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			accessNetworksUnleashed,
			islandRouter,
			islandRouterApi,
			jellyfish,
			venstar,
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
		accessNetworksUnleashed,
		islandRouter,
		islandRouterApi,
		jellyfish,
		venstar,
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
			accessNetworksUnleashed,
			islandRouter,
			islandRouterApi,
			jellyfish,
			venstar,
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

test('access networks unleashed setup can adopt a controller and save auth information', async () => {
	const config = createConfig()
	const {
		state,
		storage,
		lutron,
		sonos,
		samsungTv,
		bond,
		accessNetworksUnleashed,
		islandRouter,
		islandRouterApi,
		jellyfish,
		venstar,
	} = createAdapters(config)
	try {
		upsertDiscoveredAccessNetworksUnleashedControllers(storage, 'default', [
			{
				controllerId: '192.168.1.10',
				name: 'Unleashed Demo',
				host: '192.168.1.10',
				loginUrl: 'https://192.168.1.10/admin/login.jsp',
				lastSeenAt: '2026-05-03T21:40:00.000Z',
				rawDiscovery: { probeUrl: 'https://192.168.1.10/' },
			},
		])

		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			accessNetworksUnleashed,
			islandRouter,
			islandRouterApi,
			jellyfish,
			venstar,
		)

		const adoptResponse = await router.fetch(
			'http://example.test/access-networks-unleashed/setup',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					intent: 'adopt-controller',
					controllerId: '192.168.1.10',
				}).toString(),
			},
		)
		expect(adoptResponse.status).toBe(200)
		expect(await adoptResponse.text()).toContain(
			'Adopted Access Networks Unleashed controller Unleashed Demo.',
		)

		const saveResponse = await router.fetch(
			'http://example.test/access-networks-unleashed/setup',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					intent: 'save-credentials',
					controllerId: '192.168.1.10',
					username: 'admin-user',
					password: 'admin-pass',
				}).toString(),
			},
		)
		expect(saveResponse.status).toBe(200)
		const saveHtml = await saveResponse.text()
		expect(saveHtml).toContain('Saved auth information for Unleashed Demo.')
		expect(saveHtml).toContain('stored locally')
		expect(accessNetworksUnleashed.listControllers()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					controllerId: '192.168.1.10',
					adopted: true,
					hasStoredCredentials: true,
				}),
			]),
		)
	} finally {
		storage.close()
	}
})

test('island router api setup can save and clear the local pin', async () => {
	const config = createConfig()
	const {
		state,
		storage,
		lutron,
		sonos,
		samsungTv,
		bond,
		accessNetworksUnleashed,
		islandRouter,
		islandRouterApi,
		jellyfish,
		venstar,
	} = createAdapters(config)
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			accessNetworksUnleashed,
			islandRouter,
			islandRouterApi,
			jellyfish,
			venstar,
		)

		const setupResponse = await router.fetch(
			'http://example.test/island-router-api/setup',
		)
		expect(setupResponse.status).toBe(200)
		const setupHtml = await setupResponse.text()
		expect(setupHtml).toContain('Island Router API setup')
		expect(setupHtml).toContain('No Island Router API PIN is stored locally.')

		const saveResponse = await router.fetch(
			'http://example.test/island-router-api/setup',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					intent: 'set-pin',
					pin: '123456',
				}).toString(),
			},
		)
		expect(saveResponse.status).toBe(200)
		const saveHtml = await saveResponse.text()
		expect(saveHtml).toContain('Saved Island Router API PIN.')
		expect(saveHtml).toContain('PIN stored')
		expect(saveHtml).toContain('yes')
		expect(saveHtml).not.toContain('123456')
		expect(islandRouterApi.getStatus()).toMatchObject({
			configured: true,
			hasStoredPin: true,
		})

		const statusResponse = await router.fetch(
			'http://example.test/island-router-api/status',
		)
		expect(statusResponse.status).toBe(200)
		const statusHtml = await statusResponse.text()
		expect(statusHtml).toContain('Island Router API status')
		expect(statusHtml).toContain('https://my.islandrouter.com')

		const clearResponse = await router.fetch(
			'http://example.test/island-router-api/setup',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					intent: 'clear-pin',
				}).toString(),
			},
		)
		expect(clearResponse.status).toBe(200)
		expect(await clearResponse.text()).toContain(
			'Cleared Island Router API PIN.',
		)
		expect(islandRouterApi.getStatus()).toMatchObject({
			configured: false,
			hasStoredPin: false,
		})
	} finally {
		storage.close()
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
		accessNetworksUnleashed,
		islandRouter,
		islandRouterApi,
		jellyfish,
		venstar,
	} = createAdapters(config)
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			accessNetworksUnleashed,
			islandRouter,
			islandRouterApi,
			jellyfish,
			venstar,
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

test('system and diagnostics routes render aggregated admin surfaces', async () => {
	const config = createConfig()
	const {
		state,
		storage,
		lutron,
		sonos,
		samsungTv,
		bond,
		accessNetworksUnleashed,
		islandRouter,
		islandRouterApi,
		jellyfish,
		venstar,
	} = createAdapters(config)
	state.connection.connectorId = 'default'
	state.connection.workerUrl = 'http://localhost:3742'
	state.connection.connected = true
	state.connection.lastSyncAt = '2026-05-02T22:47:00.000Z'
	state.connection.sharedSecret = 'top-secret-value'
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			accessNetworksUnleashed,
			islandRouter,
			islandRouterApi,
			jellyfish,
			venstar,
		)
		const systemResponse = await router.fetch(
			'http://example.test/system-status',
		)
		expect(systemResponse.status).toBe(200)
		const systemHtml = await systemResponse.text()
		expect(systemHtml).toContain('System status')
		expect(systemHtml).toContain('Connector identity')
		expect(systemHtml).toContain('Island router readiness')
		expect(systemHtml).toContain('Managed endpoints')
		expect(systemHtml).toContain('2')
		expect(systemHtml).toContain('Unmanaged discoveries')
		expect(systemHtml).toContain('1')

		const diagnosticsResponse = await router.fetch(
			'http://example.test/diagnostics',
		)
		expect(diagnosticsResponse.status).toBe(200)
		const diagnosticsHtml = await diagnosticsResponse.text()
		expect(diagnosticsHtml).toContain('Diagnostics overview')
		expect(diagnosticsHtml).toContain('Diagnostics matrix')
		expect(diagnosticsHtml).toContain('Island router')
		expect(diagnosticsHtml).toContain(
			'&quot;sharedSecret&quot;: &quot;configured&quot;',
		)
		expect(diagnosticsHtml).not.toContain('top-secret-value')
	} finally {
		storage.close()
	}
})

test('dashboard starts Venstar and router reads in parallel', async () => {
	const config = createConfig()
	const {
		state,
		storage,
		lutron,
		sonos,
		samsungTv,
		bond,
		accessNetworksUnleashed,
		islandRouter,
		islandRouterApi,
		jellyfish,
		venstar,
	} = createAdapters(config)
	const started: Array<string> = []
	let resolveVenstar: (() => void) | null = null
	let resolveRouter: (() => void) | null = null
	const venstarPromise = new Promise<void>((resolve) => {
		resolveVenstar = resolve
	})
	const routerPromise = new Promise<void>((resolve) => {
		resolveRouter = resolve
	})

	const originalVenstarList = venstar.listThermostatsWithStatus
	const originalIslandRouterGetStatus = islandRouter.getStatus

	venstar.listThermostatsWithStatus = async () => {
		started.push('venstar')
		await venstarPromise
		return await originalVenstarList.call(venstar)
	}
	islandRouter.getStatus = async () => {
		started.push('router')
		await routerPromise
		return await originalIslandRouterGetStatus.call(islandRouter)
	}

	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			accessNetworksUnleashed,
			islandRouter,
			islandRouterApi,
			jellyfish,
			venstar,
		)
		const responsePromise = router.fetch('http://example.test/')
		await Promise.resolve()
		expect(started).toEqual(['venstar', 'router'])
		resolveVenstar?.()
		resolveRouter?.()
		const response = await responsePromise
		expect(response.status).toBe(200)
	} finally {
		venstar.listThermostatsWithStatus = originalVenstarList
		islandRouter.getStatus = originalIslandRouterGetStatus
		storage.close()
	}
})

test('island router status route renders configuration details and host diagnosis errors', async () => {
	const config = createConfig()
	const {
		state,
		storage,
		lutron,
		sonos,
		samsungTv,
		bond,
		accessNetworksUnleashed,
		islandRouter,
		islandRouterApi,
		jellyfish,
		venstar,
	} = createAdapters(config)
	try {
		const router = createHomeConnectorRouter(
			state,
			config,
			lutron,
			samsungTv,
			sonos,
			bond,
			accessNetworksUnleashed,
			islandRouter,
			islandRouterApi,
			jellyfish,
			venstar,
		)
		const response = await router.fetch(
			'http://example.test/island-router/status?host=192.168.1.10',
		)
		expect(response.status).toBe(200)
		const pageHtml = await response.text()
		expect(pageHtml).toContain('Island router status')
		expect(pageHtml).toContain('SSH configuration')
		expect(pageHtml).toContain('Host diagnosis')
		expect(pageHtml).toContain('Host diagnosis failed')
	} finally {
		storage.close()
	}
})
