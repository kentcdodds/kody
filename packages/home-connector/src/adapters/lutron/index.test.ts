import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../../mocks/test-server.ts'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createLutronAdapter } from './index.ts'

function createConfig() {
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.LUTRON_DISCOVERY_URL = 'http://lutron.mock.local/discovery'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	return loadHomeConnectorConfig()
}

installHomeConnectorMockServer()

test('lutron scan persists discovered processors and diagnostics', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const lutron = createLutronAdapter({
		config,
		state,
		storage,
	})

	try {
		const processors = await lutron.scan()
		const status = lutron.getStatus()

		expect(processors.length).toBeGreaterThan(0)
		expect(status.processors.length).toBe(processors.length)
		expect(status.diagnostics).not.toBeNull()
	} finally {
		storage.close()
	}
})

test('lutron inventory and commands work in mock mode with stored credentials', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const lutron = createLutronAdapter({
		config,
		state,
		storage,
	})

	try {
		const processors = await lutron.scan()
		const processorId = processors[0]!.processorId
		lutron.setCredentials(
			processorId,
			'mock-lutron-user',
			'mock-lutron-pass',
		)

		await lutron.authenticate(processorId)
		const inventory = await lutron.getInventory(processorId)
		const liveButton = inventory.sceneButtons.find(
			(button) => button.kind === 'keypad' && button.label === 'Live',
		)
		const practicalZone = inventory.zones.find(
			(zone) => zone.name === 'Practical Outlets',
		)

		expect(inventory.areas.length).toBeGreaterThan(0)
		expect(inventory.zones.length).toBeGreaterThan(0)
		expect(inventory.buttons.length).toBeGreaterThan(0)
		expect(liveButton).toBeDefined()
		expect(practicalZone).toBeDefined()

		const buttonResult = await lutron.pressButton(
			processorId,
			liveButton!.buttonId,
		)
		expect(buttonResult.ok).toBe(true)

		const zoneResult = await lutron.setZoneLevel(
			processorId,
			practicalZone!.zoneId,
			0,
		)
		expect(zoneResult.ok).toBe(true)

		const updatedInventory = await lutron.getInventory(processorId)
		const updatedZone = updatedInventory.zones.find(
			(zone) => zone.zoneId === practicalZone!.zoneId,
		)
		expect(updatedZone?.status?.switchedLevel).toBe('Off')
	} finally {
		storage.close()
	}
})
