import { type HomeConnectorConfig } from '../../config.ts'
import {
	createAccessNetworksUnleashedAjaxClient,
	normalizeAccessNetworksUnleashedMacAddress,
} from './client.ts'
import {
	type AccessNetworksUnleashedClient,
	type AccessNetworksUnleashedConfigStatus,
	type AccessNetworksUnleashedRecord,
	type AccessNetworksUnleashedSystemStatus,
	type AccessNetworksUnleashedWriteOperationId,
	type AccessNetworksUnleashedWriteOperationResult,
} from './types.ts'

type WriteOperationRequest = {
	acknowledgeHighRisk: boolean
	reason: string
	confirmation: string
}

type ClientWriteRequest = WriteOperationRequest & {
	macAddress: string
}

type WlanWriteRequest = WriteOperationRequest & {
	name: string
}

type AccessPointWriteRequest = WriteOperationRequest & {
	macAddress: string
}

type SetAccessPointLedsRequest = AccessPointWriteRequest & {
	enabled: boolean
}

const accessNetworksUnleashedWriteAcknowledgements = {
	blockClient:
		'I am highly certain blocking this WiFi client on Access Networks Unleashed is necessary right now.',
	unblockClient:
		'I am highly certain unblocking this WiFi client on Access Networks Unleashed is necessary right now.',
	enableWlan:
		'I am highly certain enabling this Access Networks Unleashed WLAN is necessary right now.',
	disableWlan:
		'I am highly certain disabling this Access Networks Unleashed WLAN is necessary right now.',
	restartAccessPoint:
		'I am highly certain restarting this Access Networks Unleashed access point is necessary right now.',
	setAccessPointLeds:
		'I am highly certain changing this Access Networks Unleashed access point LED setting is necessary right now.',
} as const

function getConfigStatus(
	config: HomeConnectorConfig,
): AccessNetworksUnleashedConfigStatus {
	const missingFields: Array<string> = []
	if (!config.accessNetworksUnleashedHost) {
		missingFields.push('ACCESS_NETWORKS_UNLEASHED_HOST')
	}
	if (!config.accessNetworksUnleashedUsername) {
		missingFields.push('ACCESS_NETWORKS_UNLEASHED_USERNAME')
	}
	if (!config.accessNetworksUnleashedPassword) {
		missingFields.push('ACCESS_NETWORKS_UNLEASHED_PASSWORD')
	}
	return {
		configured: missingFields.length === 0,
		host: config.accessNetworksUnleashedHost,
		usernameConfigured: Boolean(config.accessNetworksUnleashedUsername),
		passwordConfigured: Boolean(config.accessNetworksUnleashedPassword),
		allowInsecureTls: config.accessNetworksUnleashedAllowInsecureTls,
		missingFields,
	}
}

function assertConfigured(config: HomeConnectorConfig) {
	const status = getConfigStatus(config)
	if (!status.configured) {
		throw new Error(
			`Access Networks Unleashed is not configured. Missing: ${status.missingFields.join(', ')}.`,
		)
	}
}

function normalizeLimit(
	value: number | undefined,
	fallback: number,
	max: number,
) {
	if (value == null || !Number.isFinite(value)) return fallback
	return Math.max(1, Math.min(max, Math.trunc(value)))
}

function assertNonEmpty(value: string, field: string) {
	const trimmed = value.trim()
	if (!trimmed) throw new Error(`${field} must not be empty.`)
	return trimmed
}

function assertWriteAllowed(
	request: WriteOperationRequest,
	expectedConfirmation: string,
) {
	if (!request.acknowledgeHighRisk) {
		throw new Error('acknowledgeHighRisk must be true for this WiFi mutation.')
	}
	const reason = request.reason.trim()
	if (reason.length < 20) {
		throw new Error('reason must be at least 20 characters.')
	}
	if (request.confirmation !== expectedConfirmation) {
		throw new Error(`confirmation must exactly equal: ${expectedConfirmation}`)
	}
	return reason
}

function writeResult(input: {
	operation: AccessNetworksUnleashedWriteOperationId
	target: string
	reason: string
}): AccessNetworksUnleashedWriteOperationResult {
	return {
		operation: input.operation,
		target: input.target,
		reason: input.reason,
		completedAt: new Date().toISOString(),
	}
}

export function createAccessNetworksUnleashedAdapter(input: {
	config: HomeConnectorConfig
	client?: AccessNetworksUnleashedClient
}) {
	const { config } = input
	const client =
		input.client ?? createAccessNetworksUnleashedAjaxClient({ config })

	async function read<T>(operation: () => Promise<T>) {
		assertConfigured(config)
		return await operation()
	}

	return {
		writeAcknowledgements: accessNetworksUnleashedWriteAcknowledgements,
		getConfigStatus() {
			return getConfigStatus(config)
		},
		async getStatus(): Promise<AccessNetworksUnleashedSystemStatus> {
			const configStatus = getConfigStatus(config)
			if (!configStatus.configured) {
				return {
					config: configStatus,
					system: {},
					aps: [],
					wlans: [],
					clients: [],
					events: [],
				}
			}
			const [system, aps, wlans, clients, events] = await Promise.all([
				client.getSystemInfo(),
				client.listAccessPoints(),
				client.listWlans(),
				client.listClients(),
				client.listEvents(25),
			])
			return {
				config: configStatus,
				system,
				aps,
				wlans,
				clients,
				events,
			}
		},
		async getSystemInfo(): Promise<AccessNetworksUnleashedRecord> {
			return await read(() => client.getSystemInfo())
		},
		async listAccessPoints() {
			return await read(() => client.listAccessPoints())
		},
		async listClients() {
			return await read(() => client.listClients())
		},
		async listWlans() {
			return await read(() => client.listWlans())
		},
		async listEvents(limit?: number) {
			return await read(() => client.listEvents(normalizeLimit(limit, 50, 300)))
		},
		async blockClient(request: ClientWriteRequest) {
			assertConfigured(config)
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.blockClient,
			)
			const macAddress = normalizeAccessNetworksUnleashedMacAddress(
				request.macAddress,
			)
			await read(() => client.blockClient(macAddress))
			return writeResult({
				operation: 'block-client',
				target: macAddress,
				reason,
			})
		},
		async unblockClient(request: ClientWriteRequest) {
			assertConfigured(config)
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.unblockClient,
			)
			const macAddress = normalizeAccessNetworksUnleashedMacAddress(
				request.macAddress,
			)
			await read(() => client.unblockClient(macAddress))
			return writeResult({
				operation: 'unblock-client',
				target: macAddress,
				reason,
			})
		},
		async enableWlan(request: WlanWriteRequest) {
			assertConfigured(config)
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.enableWlan,
			)
			const name = assertNonEmpty(request.name, 'name')
			await read(() => client.setWlanEnabled(name, true))
			return writeResult({
				operation: 'enable-wlan',
				target: name,
				reason,
			})
		},
		async disableWlan(request: WlanWriteRequest) {
			assertConfigured(config)
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.disableWlan,
			)
			const name = assertNonEmpty(request.name, 'name')
			await read(() => client.setWlanEnabled(name, false))
			return writeResult({
				operation: 'disable-wlan',
				target: name,
				reason,
			})
		},
		async restartAccessPoint(request: AccessPointWriteRequest) {
			assertConfigured(config)
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.restartAccessPoint,
			)
			const macAddress = normalizeAccessNetworksUnleashedMacAddress(
				request.macAddress,
			)
			await read(() => client.restartAccessPoint(macAddress))
			return writeResult({
				operation: 'restart-ap',
				target: macAddress,
				reason,
			})
		},
		async setAccessPointLeds(request: SetAccessPointLedsRequest) {
			assertConfigured(config)
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.setAccessPointLeds,
			)
			const macAddress = normalizeAccessNetworksUnleashedMacAddress(
				request.macAddress,
			)
			await read(() => client.setAccessPointLeds(macAddress, request.enabled))
			return writeResult({
				operation: 'set-ap-leds',
				target: macAddress,
				reason,
			})
		},
	}
}
