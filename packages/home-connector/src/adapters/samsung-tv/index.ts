import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { getSamsungTvArtMode, setSamsungTvArtMode } from './art-client.ts'
import { scanSamsungTvs } from './discovery.ts'
import { samsungTvKnownApps } from './known-apps.ts'
import {
	adoptSamsungTvDevice,
	listSamsungTvDevices,
	requireSamsungTvDevice,
	saveSamsungTvToken,
	updateSamsungTvPowerState,
	updateSamsungTvTokenError,
	upsertDiscoveredSamsungTvs,
} from './repository.ts'
import {
	fetchSamsungTvAppStatus,
	fetchSamsungTvDeviceInfo,
	launchSamsungTvApp,
	pairSamsungTv,
	powerOnSamsungTv,
	sendSamsungTvRemoteKey,
} from './remote-client.ts'
import {
	type SamsungTvDeviceRecord,
	type SamsungTvKnownAppStatus,
	type SamsungTvPersistedDevice,
} from './types.ts'

function createSamsungTvDeviceRecord(input: {
	host: string
	serviceUrl: string | null
	payload: Record<string, unknown>
	adopted: boolean
}) {
	const device =
		(input.payload['device'] as Record<string, unknown> | undefined) ?? {}
	const base =
		String(device['id'] ?? '') ||
		String(device['duid'] ?? '') ||
		String(device['wifiMac'] ?? '') ||
		input.host
	return {
		deviceId: `samsung-tv-${base.replaceAll(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`,
		name:
			typeof device['name'] === 'string' && device['name'].trim().length > 0
				? device['name']
				: input.host,
		host: input.host,
		serviceUrl: input.serviceUrl,
		model: typeof device['model'] === 'string' ? device['model'] : null,
		modelName:
			typeof device['modelName'] === 'string' ? device['modelName'] : null,
		macAddress:
			typeof device['wifiMac'] === 'string' ? device['wifiMac'] : null,
		frameTvSupport:
			String(device['FrameTVSupport'] ?? '').toLowerCase() === 'true',
		tokenAuthSupport:
			String(device['TokenAuthSupport'] ?? '').toLowerCase() === 'true',
		powerState:
			typeof device['PowerState'] === 'string' ? device['PowerState'] : null,
		lastSeenAt: new Date().toISOString(),
		adopted: input.adopted,
		rawDeviceInfo: input.payload,
	} satisfies SamsungTvDeviceRecord
}

function requireSamsungTvToken(device: SamsungTvPersistedDevice) {
	if (!device.token) {
		throw new Error(
			`Samsung TV "${device.deviceId}" is not paired yet. Run samsung_pair_device first.`,
		)
	}
	return device.token
}

function requireControllableSamsungTvDevice(
	device: SamsungTvPersistedDevice,
	action: string,
) {
	if (!device.adopted) {
		throw new Error(
			`Samsung TV "${device.deviceId}" must be adopted before ${action}.`,
		)
	}
	return device
}

export function createSamsungTvAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
}) {
	function listDevices() {
		return listSamsungTvDevices(input.storage, input.config.homeConnectorId)
	}

	async function refreshDeviceInfo(device: SamsungTvPersistedDevice) {
		const payload = await fetchSamsungTvDeviceInfo(device.host)
		// Keep the existing device identity stable even if the live payload now
		// reports a different Samsung identifier string.
		const updatedDevice = {
			...createSamsungTvDeviceRecord({
				host: device.host,
				serviceUrl: device.serviceUrl,
				payload,
				adopted: device.adopted,
			}),
			deviceId: device.deviceId,
		}
		upsertDiscoveredSamsungTvs(input.storage, input.config.homeConnectorId, [
			updatedDevice,
		])
		return requireSamsungTvDevice(
			input.storage,
			input.config.homeConnectorId,
			device.deviceId,
		)
	}

	return {
		async scan() {
			const result = await scanSamsungTvs(input.state, input.config)
			return upsertDiscoveredSamsungTvs(
				input.storage,
				input.config.homeConnectorId,
				result.devices,
			)
		},
		getStatus() {
			const devices = listDevices()
			return {
				discovered: devices.filter((device) => !device.adopted),
				adopted: devices.filter((device) => device.adopted),
				allDevices: devices,
				pairedCount: devices.filter((device) => device.token).length,
				diagnostics: input.state.samsungTvDiscoveryDiagnostics,
			}
		},
		adoptDevice(deviceId: string) {
			const device = adoptSamsungTvDevice(
				input.storage,
				input.config.homeConnectorId,
				deviceId,
			)
			if (!device) {
				throw new Error(`Samsung TV "${deviceId}" was not found.`)
			}
			return device
		},
		async getDeviceInfo(deviceId: string) {
			const device = requireSamsungTvDevice(
				input.storage,
				input.config.homeConnectorId,
				deviceId,
			)
			return await refreshDeviceInfo(device)
		},
		async pairDevice(deviceId: string) {
			const device = requireSamsungTvDevice(
				input.storage,
				input.config.homeConnectorId,
				deviceId,
			)
			try {
				const result = await pairSamsungTv({
					host: device.host,
					token: device.token,
					mocksEnabled: input.config.mocksEnabled,
				})
				if (!result.token) {
					throw new Error(
						'Samsung TV pairing completed without returning a token.',
					)
				}
				saveSamsungTvToken({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					deviceId: device.deviceId,
					token: result.token,
					lastVerifiedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return requireSamsungTvDevice(
					input.storage,
					input.config.homeConnectorId,
					deviceId,
				)
			} catch (error) {
				updateSamsungTvTokenError({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					deviceId: device.deviceId,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		},
		async pressKey(deviceId: string, key: string, times = 1) {
			const device = requireControllableSamsungTvDevice(
				requireSamsungTvDevice(
					input.storage,
					input.config.homeConnectorId,
					deviceId,
				),
				'control',
			)
			const result = await sendSamsungTvRemoteKey({
				host: device.host,
				token: requireSamsungTvToken(device),
				key,
				times,
				mocksEnabled: input.config.mocksEnabled,
			})
			if (result.token) {
				saveSamsungTvToken({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					deviceId: device.deviceId,
					token: result.token,
					lastVerifiedAt: new Date().toISOString(),
					lastAuthError: null,
				})
			}
			return {
				deviceId,
				...result.result,
			}
		},
		async goHome(deviceId: string) {
			return await this.pressKey(deviceId, 'KEY_HOME')
		},
		async powerOff(deviceId: string) {
			const result = await this.pressKey(deviceId, 'KEY_POWEROFF')
			updateSamsungTvPowerState({
				storage: input.storage,
				connectorId: input.config.homeConnectorId,
				deviceId,
				powerState: 'off',
			})
			return {
				...result,
				powerState: 'off',
			}
		},
		async powerOn(deviceId: string) {
			const device = requireControllableSamsungTvDevice(
				requireSamsungTvDevice(
					input.storage,
					input.config.homeConnectorId,
					deviceId,
				),
				'power on',
			)
			if (!device.macAddress) {
				throw new Error(
					`Samsung TV "${device.deviceId}" is missing a MAC address, so Wake-on-LAN is unavailable.`,
				)
			}
			const result = await powerOnSamsungTv({
				host: device.host,
				macAddress: device.macAddress,
				mocksEnabled: input.config.mocksEnabled,
			})
			updateSamsungTvPowerState({
				storage: input.storage,
				connectorId: input.config.homeConnectorId,
				deviceId,
				powerState: 'on',
			})
			return {
				deviceId,
				powerState: 'on',
				...result.result,
			}
		},
		async getKnownAppsStatus(deviceId: string) {
			const device = requireSamsungTvDevice(
				input.storage,
				input.config.homeConnectorId,
				deviceId,
			)
			const statuses: Array<SamsungTvKnownAppStatus> = []
			for (const knownApp of samsungTvKnownApps) {
				let installedStatus = null
				let installedAppId: string | null = null
				for (const appId of knownApp.ids) {
					const status = await fetchSamsungTvAppStatus({
						host: device.host,
						appId,
						mocksEnabled: input.config.mocksEnabled,
					})
					if (status) {
						installedStatus = status
						installedAppId = appId
						break
					}
				}
				statuses.push({
					name: knownApp.name,
					appId: installedAppId,
					installed: Boolean(installedStatus),
					status: installedStatus,
				})
			}
			return {
				deviceId,
				deviceName: device.name,
				apps: statuses,
			}
		},
		async launchApp(deviceId: string, appId: string) {
			const device = requireControllableSamsungTvDevice(
				requireSamsungTvDevice(
					input.storage,
					input.config.homeConnectorId,
					deviceId,
				),
				'app launch',
			)
			const result = await launchSamsungTvApp({
				host: device.host,
				appId,
				mocksEnabled: input.config.mocksEnabled,
			})
			return {
				deviceId,
				appId,
				result,
			}
		},
		async getArtMode(deviceId: string) {
			const device = requireControllableSamsungTvDevice(
				requireSamsungTvDevice(
					input.storage,
					input.config.homeConnectorId,
					deviceId,
				),
				'reading art mode',
			)
			const result = await getSamsungTvArtMode({
				host: device.host,
				token: requireSamsungTvToken(device),
				mocksEnabled: input.config.mocksEnabled,
			})
			if (result.token) {
				saveSamsungTvToken({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					deviceId: device.deviceId,
					token: result.token,
					lastVerifiedAt: new Date().toISOString(),
					lastAuthError: null,
				})
			}
			return {
				deviceId,
				mode: result.mode,
			}
		},
		async setArtMode(deviceId: string, mode: 'on' | 'off') {
			const device = requireControllableSamsungTvDevice(
				requireSamsungTvDevice(
					input.storage,
					input.config.homeConnectorId,
					deviceId,
				),
				'changing art mode',
			)
			const result = await setSamsungTvArtMode({
				host: device.host,
				token: requireSamsungTvToken(device),
				mode,
				mocksEnabled: input.config.mocksEnabled,
			})
			if (result.token) {
				saveSamsungTvToken({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					deviceId: device.deviceId,
					token: result.token,
					lastVerifiedAt: new Date().toISOString(),
					lastAuthError: null,
				})
			}
			return {
				deviceId,
				mode,
				response: result.response,
			}
		},
		async getSummary() {
			const devices = listDevices()
			const adopted = devices.filter((device) => device.adopted)
			const detailed = []
			for (const device of adopted) {
				let artMode: 'on' | 'off' | 'unknown' = 'unknown'
				if (device.token) {
					try {
						const result = await getSamsungTvArtMode({
							host: device.host,
							token: device.token,
							mocksEnabled: input.config.mocksEnabled,
						})
						if (result.token) {
							saveSamsungTvToken({
								storage: input.storage,
								connectorId: input.config.homeConnectorId,
								deviceId: device.deviceId,
								token: result.token,
								lastVerifiedAt: new Date().toISOString(),
								lastAuthError: null,
							})
						}
						artMode = result.mode
					} catch {
						artMode = 'unknown'
					}
				}
				detailed.push({
					deviceId: device.deviceId,
					name: device.name,
					host: device.host,
					macAddress: device.macAddress,
					paired: Boolean(device.token),
					adopted: device.adopted,
					powerState: device.powerState,
					artMode,
				})
			}
			return {
				pairedCount: devices.filter((device) => device.token).length,
				deviceCount: devices.length,
				devices: detailed,
				diagnostics: input.state.samsungTvDiscoveryDiagnostics,
			}
		},
	}
}
