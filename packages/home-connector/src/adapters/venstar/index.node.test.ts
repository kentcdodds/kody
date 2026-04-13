import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../../mocks/test-server.ts'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createVenstarAdapter } from './index.ts'
import { createAppState } from '../../state.ts'

function createConfig() {
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.VENSTAR_THERMOSTATS = JSON.stringify([
		{ name: 'Hallway', ip: '192.168.10.40' },
		{ name: 'Office', ip: '192.168.10.41' },
	])
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	return loadHomeConnectorConfig()
}

installHomeConnectorMockServer()

test('venstar list returns configured thermostats with status', async () => {
	const config = createConfig()
	const venstar = createVenstarAdapter({
		config,
		state: createAppState(),
	})

	const result = await venstar.listThermostatsWithStatus()

	expect(result).toHaveLength(2)
	expect(result[0]?.summary?.spacetemp).toBeDefined()
})

test('venstar control validates auto mode setpoints', async () => {
	const config = createConfig()
	const venstar = createVenstarAdapter({
		config,
		state: createAppState(),
	})

	await expect(
		venstar.controlThermostat({
			thermostat: 'Hallway',
			mode: 3,
			heattemp: 70,
			cooltemp: 71,
		}),
	).rejects.toThrow('Auto mode requires cooltemp')
})

test('venstar settings updates complete in mock mode', async () => {
	const config = createConfig()
	const venstar = createVenstarAdapter({
		config,
		state: createAppState(),
	})

	const result = await venstar.setSettings({
		thermostat: 'Office',
		away: 1,
		schedule: 0,
		tempunits: 1,
	})

	expect(result.response.success).toBe(true)
})

test('venstar scan discovers thermostats and records diagnostics', async () => {
	const config = createConfig()
	config.venstarDiscoveryUrl = 'http://venstar.mock.local/discovery'
	const state = createAppState()
	const venstar = createVenstarAdapter({
		config,
		state,
	})

	const result = await venstar.scan()

	expect(result).toHaveLength(2)
	expect(result[0]).toMatchObject({
		name: 'Hallway',
		ip: '192.168.10.40',
	})
	expect(venstar.getStatus()).toMatchObject({
		discovered: [],
		diagnostics: expect.objectContaining({
			protocol: 'json',
		}),
	})
})
