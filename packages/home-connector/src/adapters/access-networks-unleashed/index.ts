import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	createAccessNetworksUnleashedAjaxClient,
	normalizeAccessNetworksUnleashedMacAddress,
} from './client.ts'
import { scanAccessNetworksUnleashedControllers } from './discovery.ts'
import {
	adoptAccessNetworksUnleashedController,
	getAccessNetworksUnleashedController,
	getAdoptedAccessNetworksUnleashedController,
	listAccessNetworksUnleashedPublicControllers,
	removeAccessNetworksUnleashedController,
	saveAccessNetworksUnleashedCredentials,
	toAccessNetworksUnleashedPublicController,
	updateAccessNetworksUnleashedAuthStatus,
	upsertDiscoveredAccessNetworksUnleashedControllers,
} from './repository.ts'
import {
	type AccessNetworksUnleashedConfigStatus,
	type AccessNetworksUnleashedPersistedController,
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

type ControllerCredentialsRequest = {
	controllerId: string
	username: string
	password: string
}

type ControllerSelectionRequest = {
	controllerId: string
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
	controller: AccessNetworksUnleashedPersistedController | null,
): AccessNetworksUnleashedConfigStatus {
	const missingRequirements: Array<'controller' | 'credentials'> = []
	if (!controller) {
		missingRequirements.push('controller')
	}
	if (!controller?.username || !controller?.password) {
		missingRequirements.push('credentials')
	}
	return {
		configured: missingRequirements.length === 0,
		adoptedControllerId: controller?.controllerId ?? null,
		host: controller?.host ?? null,
		hasAdoptedController: Boolean(controller),
		hasStoredCredentials: Boolean(controller?.username && controller?.password),
		allowInsecureTls: config.accessNetworksUnleashedAllowInsecureTls,
		missingRequirements,
		lastAuthenticatedAt: controller?.lastAuthenticatedAt ?? null,
		lastAuthError: controller?.lastAuthError ?? null,
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
	state: HomeConnectorState
	storage: HomeConnectorStorage
	clientFactory?: (
		controller: AccessNetworksUnleashedPersistedController,
	) => AccessNetworksUnleashedClient
	scanControllers?: () => Promise<{
		controllers: Array<AccessNetworksUnleashedPersistedController>
		diagnostics: HomeConnectorState['accessNetworksUnleashedDiscoveryDiagnostics']
	}>
}) {
	const { config, state, storage } = input
	const connectorId = config.homeConnectorId

	async function read<T>(operation: () => Promise<T>) {
		requireControllerWithCredentials()
		return await operation()
	}

	function listControllers() {
		return listAccessNetworksUnleashedPublicControllers(storage, connectorId)
	}

	function requireController(controllerId: string) {
		const controller = getAccessNetworksUnleashedController(
			storage,
			connectorId,
			controllerId,
		)
		if (!controller) {
			throw new Error(
				`Access Networks Unleashed controller "${controllerId}" was not found.`,
			)
		}
		return controller
	}

	function requireAdoptedController() {
		const controller = getAdoptedAccessNetworksUnleashedController(
			storage,
			connectorId,
		)
		if (!controller) {
			throw new Error(
				'No Access Networks Unleashed controller is adopted yet. Run access_networks_unleashed_scan_controllers, then access_networks_unleashed_adopt_controller.',
			)
		}
		return controller
	}

	function requireControllerWithCredentials() {
		const controller = requireAdoptedController()
		if (!controller.username || !controller.password) {
			throw new Error(
				'The adopted Access Networks Unleashed controller is missing stored credentials. Run access_networks_unleashed_set_credentials first.',
			)
		}
		return controller
	}

	let cachedClientKey: string | null = null
	let cachedClient: AccessNetworksUnleashedClient | null = null

	function createClient() {
		const controller = requireControllerWithCredentials()
		const cacheKey = JSON.stringify({
			controllerId: controller.controllerId,
			host: controller.host,
			username: controller.username,
			password: controller.password,
		})
		if (cachedClient && cachedClientKey === cacheKey) {
			return cachedClient
		}
		cachedClient =
			input.clientFactory?.(controller) ??
			createAccessNetworksUnleashedAjaxClient({
				config,
				controller,
			})
		cachedClientKey = cacheKey
		return cachedClient
	}

	return {
		writeAcknowledgements: accessNetworksUnleashedWriteAcknowledgements,
		getConfigStatus() {
			return getConfigStatus(
				config,
				getAdoptedAccessNetworksUnleashedController(storage, connectorId),
			)
		},
		listControllers,
		async scan() {
			if (input.scanControllers) {
				const result = await input.scanControllers()
				if (result.diagnostics) {
					state.accessNetworksUnleashedDiscoveryDiagnostics = result.diagnostics
				}
				upsertDiscoveredAccessNetworksUnleashedControllers(
					storage,
					connectorId,
					result.controllers,
				)
				return listControllers()
			}
			const result = await scanAccessNetworksUnleashedControllers(state, config)
			upsertDiscoveredAccessNetworksUnleashedControllers(
				storage,
				connectorId,
				result.controllers,
			)
			return listControllers()
		},
		adoptController(request: ControllerSelectionRequest) {
			const controller = requireController(request.controllerId)
			adoptAccessNetworksUnleashedController(
				storage,
				connectorId,
				controller.controllerId,
			)
			cachedClient = null
			cachedClientKey = null
			return toAccessNetworksUnleashedPublicController({
				...controller,
				adopted: true,
			})
		},
		removeController(request: ControllerSelectionRequest) {
			const controller = requireController(request.controllerId)
			removeAccessNetworksUnleashedController({
				storage,
				connectorId,
				controllerId: controller.controllerId,
			})
			cachedClient = null
			cachedClientKey = null
			return toAccessNetworksUnleashedPublicController(controller)
		},
		setCredentials(request: ControllerCredentialsRequest) {
			requireController(request.controllerId)
			const username = assertNonEmpty(request.username, 'username')
			const password = assertNonEmpty(request.password, 'password')
			saveAccessNetworksUnleashedCredentials({
				storage,
				connectorId,
				controllerId: request.controllerId,
				username,
				password,
			})
			cachedClient = null
			cachedClientKey = null
			return toAccessNetworksUnleashedPublicController(
				requireController(request.controllerId),
			)
		},
		async authenticate(controllerId?: string) {
			const controller = controllerId
				? requireController(controllerId)
				: requireAdoptedController()
			if (!controller.username || !controller.password) {
				throw new Error(
					`Access Networks Unleashed controller "${controller.controllerId}" is missing stored credentials. Run access_networks_unleashed_set_credentials first.`,
				)
			}
			try {
				cachedClient = null
				cachedClientKey = null
				await (
					input.clientFactory?.(controller) ??
					createAccessNetworksUnleashedAjaxClient({
						config,
						controller,
					})
				).getSystemInfo()
				updateAccessNetworksUnleashedAuthStatus({
					storage,
					connectorId,
					controllerId: controller.controllerId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
			} catch (error) {
				updateAccessNetworksUnleashedAuthStatus({
					storage,
					connectorId,
					controllerId: controller.controllerId,
					lastAuthenticatedAt: null,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
			return toAccessNetworksUnleashedPublicController(
				requireController(controller.controllerId),
			)
		},
		async getStatus(): Promise<AccessNetworksUnleashedSystemStatus> {
			const adoptedController = getAdoptedAccessNetworksUnleashedController(
				storage,
				connectorId,
			)
			const configStatus = getConfigStatus(config, adoptedController)
			if (!configStatus.hasAdoptedController) {
				return {
					config: configStatus,
					controller: null,
					controllers: listControllers(),
					diagnostics: state.accessNetworksUnleashedDiscoveryDiagnostics,
					error: null,
					system: {},
					aps: [],
					wlans: [],
					clients: [],
					events: [],
				}
			}
			if (!configStatus.hasStoredCredentials) {
				return {
					config: configStatus,
					controller:
						toAccessNetworksUnleashedPublicController(adoptedController),
					controllers: listControllers(),
					diagnostics: state.accessNetworksUnleashedDiscoveryDiagnostics,
					error: null,
					system: {},
					aps: [],
					wlans: [],
					clients: [],
					events: [],
				}
			}
			try {
				const client = createClient()
				const [system, aps, wlans, clients, events] = await Promise.all([
					client.getSystemInfo(),
					client.listAccessPoints(),
					client.listWlans(),
					client.listClients(),
					client.listEvents(25),
				])
				updateAccessNetworksUnleashedAuthStatus({
					storage,
					connectorId,
					controllerId: adoptedController.controllerId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					config: getConfigStatus(
						config,
						getAdoptedAccessNetworksUnleashedController(storage, connectorId),
					),
					controller: toAccessNetworksUnleashedPublicController(
						requireAdoptedController(),
					),
					controllers: listControllers(),
					diagnostics: state.accessNetworksUnleashedDiscoveryDiagnostics,
					error: null,
					system,
					aps,
					wlans,
					clients,
					events,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				updateAccessNetworksUnleashedAuthStatus({
					storage,
					connectorId,
					controllerId: adoptedController.controllerId,
					lastAuthenticatedAt: null,
					lastAuthError: message,
				})
				return {
					config: getConfigStatus(
						config,
						getAdoptedAccessNetworksUnleashedController(storage, connectorId),
					),
					controller: toAccessNetworksUnleashedPublicController(
						requireAdoptedController(),
					),
					controllers: listControllers(),
					diagnostics: state.accessNetworksUnleashedDiscoveryDiagnostics,
					error: message,
					system: {},
					aps: [],
					wlans: [],
					clients: [],
					events: [],
				}
			}
		},
		async getSystemInfo(): Promise<AccessNetworksUnleashedRecord> {
			return await read(() => createClient().getSystemInfo())
		},
		async listAccessPoints() {
			return await read(() => createClient().listAccessPoints())
		},
		async listClients() {
			return await read(() => createClient().listClients())
		},
		async listWlans() {
			return await read(() => createClient().listWlans())
		},
		async listEvents(limit?: number) {
			return await read(() =>
				createClient().listEvents(normalizeLimit(limit, 50, 300)),
			)
		},
		async blockClient(request: ClientWriteRequest) {
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.blockClient,
			)
			const macAddress = normalizeAccessNetworksUnleashedMacAddress(
				request.macAddress,
			)
			await read(() => createClient().blockClient(macAddress))
			return writeResult({
				operation: 'block-client',
				target: macAddress,
				reason,
			})
		},
		async unblockClient(request: ClientWriteRequest) {
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.unblockClient,
			)
			const macAddress = normalizeAccessNetworksUnleashedMacAddress(
				request.macAddress,
			)
			await read(() => createClient().unblockClient(macAddress))
			return writeResult({
				operation: 'unblock-client',
				target: macAddress,
				reason,
			})
		},
		async enableWlan(request: WlanWriteRequest) {
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.enableWlan,
			)
			const name = assertNonEmpty(request.name, 'name')
			await read(() => createClient().setWlanEnabled(name, true))
			return writeResult({
				operation: 'enable-wlan',
				target: name,
				reason,
			})
		},
		async disableWlan(request: WlanWriteRequest) {
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.disableWlan,
			)
			const name = assertNonEmpty(request.name, 'name')
			await read(() => createClient().setWlanEnabled(name, false))
			return writeResult({
				operation: 'disable-wlan',
				target: name,
				reason,
			})
		},
		async restartAccessPoint(request: AccessPointWriteRequest) {
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.restartAccessPoint,
			)
			const macAddress = normalizeAccessNetworksUnleashedMacAddress(
				request.macAddress,
			)
			await read(() => createClient().restartAccessPoint(macAddress))
			return writeResult({
				operation: 'restart-ap',
				target: macAddress,
				reason,
			})
		},
		async setAccessPointLeds(request: SetAccessPointLedsRequest) {
			const reason = assertWriteAllowed(
				request,
				accessNetworksUnleashedWriteAcknowledgements.setAccessPointLeds,
			)
			const macAddress = normalizeAccessNetworksUnleashedMacAddress(
				request.macAddress,
			)
			await read(() =>
				createClient().setAccessPointLeds(macAddress, request.enabled),
			)
			return writeResult({
				operation: 'set-ap-leds',
				target: macAddress,
				reason,
			})
		},
	}
}
