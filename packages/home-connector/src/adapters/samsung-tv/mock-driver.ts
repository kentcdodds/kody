import { type SamsungTvAppStatus, type SamsungTvDeviceRecord } from './types.ts'

type MockSamsungTvDevice = SamsungTvDeviceRecord & {
	token: string
	knownApps: Record<string, SamsungTvAppStatus>
	artMode: 'on' | 'off'
}

const initialMockSamsungDevices: Array<MockSamsungTvDevice> = [
	{
		deviceId: 'samsung-frame-living-room',
		name: 'Living Room The Frame',
		host: 'frame-tv.mock.local',
		serviceUrl: 'http://frame-tv.mock.local:8001/api/v2/',
		model: '24_PONTUSM_FTV',
		modelName: 'QN65LS03DAFXZA',
		macAddress: 'F4:DD:06:67:B6:16',
		frameTvSupport: true,
		tokenAuthSupport: true,
		powerState: 'on',
		lastSeenAt: '2026-03-25T17:00:00.000Z',
		adopted: true,
		rawDeviceInfo: {
			device: {
				FrameTVSupport: 'true',
				TokenAuthSupport: 'true',
				PowerState: 'on',
				model: '24_PONTUSM_FTV',
				modelName: 'QN65LS03DAFXZA',
				name: 'Living Room The Frame',
				type: 'Samsung SmartTV',
				wifiMac: 'F4:DD:06:67:B6:16',
			},
			type: 'Samsung SmartTV',
			version: '2.0.25',
		},
		token: 'mock-samsung-token',
		knownApps: {
			'111299001912': {
				appId: '111299001912',
				name: 'YouTube',
				running: false,
				visible: false,
				version: '2.1.527',
			},
			'3201907018807': {
				appId: '3201907018807',
				name: 'Netflix',
				running: true,
				visible: true,
				version: '70.23.15080',
			},
			'3201910019365': {
				appId: '3201910019365',
				name: 'Prime Video',
				running: false,
				visible: false,
				version: '5.3.2',
			},
		},
		artMode: 'off',
	},
	{
		deviceId: 'samsung-frame-bedroom',
		name: 'Bedroom The Frame',
		host: 'bedroom-frame.mock.local',
		serviceUrl: 'http://bedroom-frame.mock.local:8001/api/v2/',
		model: '24_PONTUSM_FTV',
		modelName: 'QN55LS03DAFXZA',
		macAddress: 'AA:BB:CC:DD:EE:FF',
		frameTvSupport: true,
		tokenAuthSupport: true,
		powerState: 'on',
		lastSeenAt: '2026-03-25T17:00:00.000Z',
		adopted: false,
		rawDeviceInfo: {
			device: {
				FrameTVSupport: 'true',
				TokenAuthSupport: 'true',
				PowerState: 'on',
				model: '24_PONTUSM_FTV',
				modelName: 'QN55LS03DAFXZA',
				name: 'Bedroom The Frame',
				type: 'Samsung SmartTV',
				wifiMac: 'AA:BB:CC:DD:EE:FF',
			},
			type: 'Samsung SmartTV',
			version: '2.0.25',
		},
		token: 'mock-bedroom-token',
		knownApps: {},
		artMode: 'on',
	},
]

let mockSamsungDevices = structuredClone(initialMockSamsungDevices)

function findMockSamsungDevice(host: string) {
	return mockSamsungDevices.find((device) => device.host === host) ?? null
}

export function resetMockSamsungDevices() {
	mockSamsungDevices = structuredClone(initialMockSamsungDevices)
}

export function listMockSamsungDevices() {
	return structuredClone(
		mockSamsungDevices.map((device) => ({
			deviceId: device.deviceId,
			name: device.name,
			host: device.host,
			serviceUrl: device.serviceUrl,
			model: device.model,
			modelName: device.modelName,
			macAddress: device.macAddress,
			frameTvSupport: device.frameTvSupport,
			tokenAuthSupport: device.tokenAuthSupport,
			powerState: device.powerState,
			lastSeenAt: device.lastSeenAt,
			adopted: device.adopted,
			rawDeviceInfo: device.rawDeviceInfo,
		})),
	)
}

export function getMockSamsungDeviceInfo(host: string) {
	const device = findMockSamsungDevice(host)
	if (!device) {
		throw new Error(`Unknown mock Samsung TV host "${host}".`)
	}
	return structuredClone({
		...device.rawDeviceInfo,
		device: {
			...((device.rawDeviceInfo?.['device'] as
				| Record<string, unknown>
				| undefined) ?? {}),
			PowerState: device.powerState,
		},
	})
}

export function getMockSamsungAppStatus(host: string, appId: string) {
	const device = findMockSamsungDevice(host)
	if (!device) {
		throw new Error(`Unknown mock Samsung TV host "${host}".`)
	}
	return device.knownApps[appId]
		? structuredClone(device.knownApps[appId])
		: null
}

export function launchMockSamsungApp(host: string, appId: string) {
	const device = findMockSamsungDevice(host)
	if (!device) {
		throw new Error(`Unknown mock Samsung TV host "${host}".`)
	}
	const app = device.knownApps[appId]
	if (!app) {
		throw new Error(`Unknown mock Samsung TV app "${appId}".`)
	}
	for (const candidate of Object.values(device.knownApps)) {
		candidate.running = false
		candidate.visible = false
	}
	device.powerState = 'on'
	app.running = true
	app.visible = true
	device.artMode = 'off'
	return structuredClone(app)
}

export function issueMockSamsungToken(host: string) {
	const device = findMockSamsungDevice(host)
	if (!device) {
		throw new Error(`Unknown mock Samsung TV host "${host}".`)
	}
	device.token = `${device.deviceId}-token`
	return device.token
}

export function validateMockSamsungToken(host: string, token: string | null) {
	const device = findMockSamsungDevice(host)
	if (!device) return false
	return Boolean(token) && token === device.token
}

export function sendMockSamsungRemoteKey(host: string, key: string, times = 1) {
	const device = findMockSamsungDevice(host)
	if (!device) {
		throw new Error(`Unknown mock Samsung TV host "${host}".`)
	}
	for (let index = 0; index < times; index += 1) {
		if (device.powerState === 'off' && key !== 'KEY_POWER') {
			continue
		}
		switch (key) {
			case 'KEY_HOME':
				device.powerState = 'on'
				device.artMode = 'off'
				break
			case 'KEY_POWER':
				if (device.powerState === 'off') {
					device.powerState = 'on'
					device.artMode = 'off'
					break
				}
				device.artMode = device.artMode === 'on' ? 'off' : 'on'
				break
			case 'KEY_POWEROFF':
				device.powerState = 'off'
				device.artMode = 'off'
				break
			default:
				break
		}
	}
	return {
		ok: true,
		deviceId: device.deviceId,
		key,
		times,
	}
}

export function getMockSamsungArtMode(host: string) {
	const device = findMockSamsungDevice(host)
	if (!device) {
		throw new Error(`Unknown mock Samsung TV host "${host}".`)
	}
	return device.artMode
}

export function setMockSamsungArtMode(host: string, mode: 'on' | 'off') {
	const device = findMockSamsungDevice(host)
	if (!device) {
		throw new Error(`Unknown mock Samsung TV host "${host}".`)
	}
	device.powerState = 'on'
	device.artMode = mode
	return {
		deviceId: device.deviceId,
		mode,
	}
}

export function powerOnMockSamsungTv(host: string) {
	const device = findMockSamsungDevice(host)
	if (!device) {
		throw new Error(`Unknown mock Samsung TV host "${host}".`)
	}
	device.powerState = 'on'
	device.artMode = 'off'
	return {
		deviceId: device.deviceId,
		powerState: device.powerState,
	}
}
