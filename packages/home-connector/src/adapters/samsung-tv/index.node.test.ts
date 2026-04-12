import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../../mocks/test-server.ts'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createSamsungTvAdapter } from './index.ts'
import { upsertDiscoveredSamsungTvs } from './repository.ts'

function createConfig() {
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.SAMSUNG_TV_DISCOVERY_URL =
		'http://samsung-tv.mock.local/discovery'
	process.env.VENSTAR_THERMOSTATS = '[]'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	return loadHomeConnectorConfig()
}

installHomeConnectorMockServer()

test('samsung tv scan persists discovered devices and diagnostics', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const samsungTv = createSamsungTvAdapter({
		config,
		state,
		storage,
	})

	try {
		const devices = await samsungTv.scan()
		const status = samsungTv.getStatus()

		expect(devices.length).toBeGreaterThan(0)
		expect(status.allDevices.length).toBe(devices.length)
		expect(status.diagnostics).not.toBeNull()
	} finally {
		storage.close()
	}
})

test('samsung tv pairing stores a reusable token for an adopted device', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const samsungTv = createSamsungTvAdapter({
		config,
		state,
		storage,
	})

	try {
		const devices = await samsungTv.scan()
		const deviceId = devices[0]!.deviceId
		samsungTv.adoptDevice(deviceId)

		const paired = await samsungTv.pairDevice(deviceId)

		expect(paired.token).toBeTruthy()
		expect(samsungTv.getStatus().pairedCount).toBe(1)
	} finally {
		storage.close()
	}
})

test('samsung tv control and art mode work in mock mode after pairing', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const samsungTv = createSamsungTvAdapter({
		config,
		state,
		storage,
	})

	try {
		const devices = await samsungTv.scan()
		const deviceId = devices.find(
			(device) => device.name === 'Living Room The Frame',
		)!.deviceId
		samsungTv.adoptDevice(deviceId)
		await samsungTv.pairDevice(deviceId)

		const keypress = await samsungTv.pressKey(deviceId, 'KEY_MUTE')
		const apps = await samsungTv.getKnownAppsStatus(deviceId)
		const launch = await samsungTv.launchApp(deviceId, '3201907018807')
		const artModeOn = await samsungTv.setArtMode(deviceId, 'on')
		const artMode = await samsungTv.getArtMode(deviceId)

		expect(keypress).toMatchObject({
			ok: true,
			deviceId,
			key: 'KEY_MUTE',
		})
		expect(
			apps.apps.some((app) => app.name === 'Netflix' && app.installed),
		).toBe(true)
		expect(launch).toMatchObject({
			deviceId,
			appId: '3201907018807',
		})
		expect(artModeOn.mode).toBe('on')
		expect(artMode.mode).toBe('on')
	} finally {
		storage.close()
	}
})

test('samsung tv power off and power on update the stored power state', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const samsungTv = createSamsungTvAdapter({
		config,
		state,
		storage,
	})

	try {
		const devices = await samsungTv.scan()
		const deviceId = devices.find(
			(device) => device.name === 'Living Room The Frame',
		)!.deviceId
		samsungTv.adoptDevice(deviceId)
		await samsungTv.pairDevice(deviceId)

		const poweredOff = await samsungTv.powerOff(deviceId)
		const statusAfterOff = samsungTv.getStatus()
		const poweredOn = await samsungTv.powerOn(deviceId)
		const statusAfterOn = samsungTv.getStatus()

		expect(poweredOff).toMatchObject({
			deviceId,
			powerState: 'off',
		})
		expect(
			statusAfterOff.allDevices.find((device) => device.deviceId === deviceId)
				?.powerState,
		).toBe('off')
		expect(poweredOn).toMatchObject({
			deviceId,
			powerState: 'on',
		})
		expect(
			statusAfterOn.allDevices.find((device) => device.deviceId === deviceId)
				?.powerState,
		).toBe('on')
	} finally {
		storage.close()
	}
})

test('samsung tv refresh keeps the original device id stable', async () => {
	const config = {
		...createConfig(),
		mocksEnabled: false,
	}
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const samsungTv = createSamsungTvAdapter({
		config,
		state,
		storage,
	})
	const originalFetch = globalThis.fetch
	const originalDeviceId = 'samsung-tv-stable-id'
	const host = 'identity-refresh.test'

	globalThis.fetch = async (input, init) => {
		const url = String(input)
		if (url === `http://${host}:8001/api/v2/`) {
			return new Response(
				JSON.stringify({
					device: {
						id: 'uuid:changed-after-refresh',
						name: 'Renamed Frame TV',
						model: '24_PONTUSM_FTV',
						modelName: 'QN65LS03DAFXZA',
						wifiMac: 'F4:DD:06:67:B6:16',
						FrameTVSupport: 'true',
						TokenAuthSupport: 'true',
						PowerState: 'on',
					},
				}),
				{
					headers: {
						'Content-Type': 'application/json',
					},
				},
			)
		}
		return await originalFetch(input, init)
	}

	try {
		upsertDiscoveredSamsungTvs(storage, config.homeConnectorId, [
			{
				deviceId: originalDeviceId,
				name: 'Original Frame TV',
				host,
				serviceUrl: `http://${host}:8001/api/v2/`,
				model: null,
				modelName: null,
				macAddress: null,
				frameTvSupport: false,
				tokenAuthSupport: true,
				powerState: null,
				lastSeenAt: new Date().toISOString(),
				adopted: true,
				rawDeviceInfo: {
					device: {
						id: 'uuid:original',
					},
				},
			},
		])

		const refreshed = await samsungTv.getDeviceInfo(originalDeviceId)
		const status = samsungTv.getStatus()

		expect(refreshed.deviceId).toBe(originalDeviceId)
		expect(refreshed.name).toBe('Renamed Frame TV')
		expect(status.allDevices).toHaveLength(1)
		expect(status.allDevices[0]?.deviceId).toBe(originalDeviceId)
		expect(status.allDevices[0]?.name).toBe('Renamed Frame TV')
	} finally {
		globalThis.fetch = originalFetch
		storage.close()
	}
})
