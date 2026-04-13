import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../../mocks/test-server.ts'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { upsertVenstarThermostat } from './repository.ts'
import { createVenstarAdapter } from './index.ts'

function createConfig() {
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	process.env.VENSTAR_SCAN_CIDRS = '192.168.10.40/32,192.168.10.41/32'
	return loadHomeConnectorConfig()
}

function createVenstarFixture() {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	upsertVenstarThermostat({
		storage,
		connectorId: config.homeConnectorId,
		name: 'Hallway',
		ip: '192.168.10.40',
	})
	upsertVenstarThermostat({
		storage,
		connectorId: config.homeConnectorId,
		name: 'Office',
		ip: '192.168.10.41',
	})
	return {
		config,
		state,
		storage,
		venstar: createVenstarAdapter({
			config,
			state,
			storage,
		}),
	}
}

installHomeConnectorMockServer()

test('venstar list returns managed thermostats with status', async () => {
	const { storage, venstar } = createVenstarFixture()
	try {
		const result = await venstar.listThermostatsWithStatus()

		expect(result).toHaveLength(2)
		expect(result[0]?.summary?.spacetemp).toBeDefined()
	} finally {
		storage.close()
	}
})

test('venstar control validates auto mode setpoints', async () => {
	const { storage, venstar } = createVenstarFixture()
	try {
		await expect(
			venstar.controlThermostat({
				thermostat: 'Hallway',
				mode: 3,
				heattemp: 70,
				cooltemp: 71,
			}),
		).rejects.toThrow('Auto mode requires cooltemp')
	} finally {
		storage.close()
	}
})

test('venstar settings updates complete in mock mode', async () => {
	const { storage, venstar } = createVenstarFixture()
	try {
		const result = await venstar.setSettings({
			thermostat: 'Office',
			away: 1,
			schedule: 0,
			tempunits: 1,
		})

		expect(result.response.success).toBe(true)
	} finally {
		storage.close()
	}
})

test('venstar scan discovers thermostats and records diagnostics', async () => {
	const { state, storage, venstar } = createVenstarFixture()
	try {
		const result = await venstar.scan()

		expect(result).toHaveLength(2)
		expect(result[0]).toMatchObject({
			name: 'Hallway',
			ip: '192.168.10.40',
		})
		expect(venstar.getStatus()).toMatchObject({
			discovered: [],
			diagnostics: expect.objectContaining({
				protocol: 'subnet',
			}),
		})
		expect(state.venstarDiscoveredThermostats).toHaveLength(2)
	} finally {
		storage.close()
	}
})
