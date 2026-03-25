import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../../mocks/test-server.ts'
import { createAppState } from '../../state.ts'
import { loadHomeConnectorConfig } from '../../config.ts'
import {
	adoptRoku,
	createRokuAdapter,
	getRokuStatus,
	scanRokuDevices,
} from './index.ts'

function createConfig() {
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.ROKU_DISCOVERY_URL = 'http://roku.mock.local/discovery'
	return loadHomeConnectorConfig()
}

installHomeConnectorMockServer()

test('roku scan populates discovered devices', async () => {
	const config = createConfig()
	const state = createAppState()

	const devices = await scanRokuDevices(state, config)
	const status = getRokuStatus(state)

	expect(devices.length).toBeGreaterThan(0)
	expect(status.discovered.length).toBe(devices.length)
	expect(status.adopted.length).toBe(0)
	expect(status.diagnostics).not.toBeNull()
})

test('adopting a discovered roku moves it into adopted devices', async () => {
	const config = createConfig()
	const state = createAppState()

	const devices = await scanRokuDevices(state, config)
	const adopted = adoptRoku(state, devices[0]!.deviceId)
	const status = getRokuStatus(state)

	expect(adopted.adopted).toBe(true)
	expect(
		status.adopted.some((device) => device.deviceId === adopted.deviceId),
	).toBe(true)
})

test('sending a Roku keypress uses the discovered device location', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })

	const devices = await roku.scan()
	const deviceId = devices[0]!.deviceId
	roku.adoptDevice(deviceId)

	const result = await roku.pressKey(deviceId, 'Home')

	expect(result.ok).toBe(true)
	expect(result.deviceId).toBe(deviceId)
	expect(result.key).toBe('Home')
})

test('launching a Roku app succeeds for an adopted device', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })

	const devices = await roku.scan()
	const deviceId = devices[0]!.deviceId
	roku.adoptDevice(deviceId)

	const result = await roku.launchApp(deviceId, '837', {
		contentID: '07RZ_2AyKHQ',
		mediaType: 'live',
	})

	expect(result.ok).toBe(true)
	expect(result.deviceId).toBe(deviceId)
	expect(result.appId).toBe('837')
	expect(result.params).toEqual({
		contentID: '07RZ_2AyKHQ',
		mediaType: 'live',
	})
})

test('listing Roku apps returns structured app metadata', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })

	const devices = await roku.scan()
	const deviceId = devices[0]!.deviceId
	roku.adoptDevice(deviceId)

	const result = await roku.listApps(deviceId)

	expect(result.deviceId).toBe(deviceId)
	expect(result.deviceName).toBe('Living Room Roku')
	expect(result.apps.length).toBeGreaterThan(0)
	expect(result.apps[0]).toMatchObject({
		id: '837',
		name: 'YouTube',
		type: 'appl',
		version: '5.7.0',
	})
})

test('getting the active Roku app returns the current app metadata', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })

	const devices = await roku.scan()
	const deviceId = devices[0]!.deviceId
	roku.adoptDevice(deviceId)

	const result = await roku.getActiveApp(deviceId)

	expect(result.deviceId).toBe(deviceId)
	expect(result.deviceName).toBe('Living Room Roku')
	expect(result.app).toMatchObject({
		id: '13842',
		name: 'Jellyfin',
		type: 'appl',
		version: '2.0.1',
	})
})
