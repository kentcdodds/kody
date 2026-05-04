import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { createAccessNetworksUnleashedAjaxClient } from './client.ts'
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
	type AccessNetworksUnleashedAjaxAction,
	type AccessNetworksUnleashedClient,
	type AccessNetworksUnleashedConfigStatus,
	type AccessNetworksUnleashedDiscoveredController,
	type AccessNetworksUnleashedPersistedController,
	type AccessNetworksUnleashedRequestInput,
	type AccessNetworksUnleashedRequestResult,
} from './types.ts'

type ControllerCredentialsRequest = {
	controllerId: string
	username: string
	password: string
}

type ControllerSelectionRequest = {
	controllerId: string
}

type WriteOperationRequest = {
	acknowledgeHighRisk: boolean
	reason: string
	confirmation: string
}

type RequestCapabilityRequest = WriteOperationRequest &
	AccessNetworksUnleashedRequestInput

export const accessNetworksUnleashedRequestConfirmation =
	'I am highly certain making this raw Access Networks Unleashed AJAX request is necessary right now.'

const validActions: ReadonlySet<AccessNetworksUnleashedAjaxAction> =
	new Set<AccessNetworksUnleashedAjaxAction>(['getstat', 'setconf', 'docmd'])

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
		throw new Error(
			'acknowledgeHighRisk must be true for this Access Networks Unleashed request.',
		)
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

export function createAccessNetworksUnleashedAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
	clientFactory?: (
		controller: AccessNetworksUnleashedPersistedController,
	) => AccessNetworksUnleashedClient
	scanControllers?: () => Promise<{
		controllers: Array<AccessNetworksUnleashedDiscoveredController>
		diagnostics: HomeConnectorState['accessNetworksUnleashedDiscoveryDiagnostics']
	}>
}) {
	const { config, state, storage } = input
	const connectorId = config.homeConnectorId

	function listControllers() {
		return listAccessNetworksUnleashedPublicControllers(storage, connectorId)
	}

	function getAdoptedController() {
		const controller = getAdoptedAccessNetworksUnleashedController(
			storage,
			connectorId,
		)
		return controller
			? toAccessNetworksUnleashedPublicController(controller)
			: null
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
		requestConfirmation: accessNetworksUnleashedRequestConfirmation,
		getConfigStatus() {
			return getConfigStatus(
				config,
				getAdoptedAccessNetworksUnleashedController(storage, connectorId),
			)
		},
		getDiscoveryDiagnostics() {
			return state.accessNetworksUnleashedDiscoveryDiagnostics
		},
		listControllers,
		getAdoptedController,
		async scan() {
			if (input.scanControllers) {
				const result = await input.scanControllers()
				state.accessNetworksUnleashedDiscoveryDiagnostics = result.diagnostics
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
			cachedClient = null
			cachedClientKey = null
			const client =
				input.clientFactory?.(controller) ??
				createAccessNetworksUnleashedAjaxClient({
					config,
					controller,
				})
			try {
				await client.request({
					action: 'getstat',
					comp: 'system',
					xmlBody: '<sysinfo/>',
				})
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
					lastAuthenticatedAt: controller.lastAuthenticatedAt,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
			return toAccessNetworksUnleashedPublicController(
				requireController(controller.controllerId),
			)
		},
		async request(
			request: RequestCapabilityRequest,
		): Promise<AccessNetworksUnleashedRequestResult> {
			assertWriteAllowed(request, accessNetworksUnleashedRequestConfirmation)
			if (!validActions.has(request.action)) {
				throw new Error(
					`action must be one of: ${[...validActions].join(', ')}.`,
				)
			}
			const comp = assertNonEmpty(request.comp, 'comp')
			const xmlBody = request.xmlBody
			if (typeof xmlBody !== 'string') {
				throw new Error('xmlBody must be a string of inner ajax-request XML.')
			}
			const client = createClient()
			const adoptedController = requireControllerWithCredentials()
			try {
				const result = await client.request({
					action: request.action,
					comp,
					xmlBody,
					updater: request.updater,
					allowInsecureTls: request.allowInsecureTls,
				})
				updateAccessNetworksUnleashedAuthStatus({
					storage,
					connectorId,
					controllerId: adoptedController.controllerId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return result
			} catch (error) {
				updateAccessNetworksUnleashedAuthStatus({
					storage,
					connectorId,
					controllerId: adoptedController.controllerId,
					lastAuthenticatedAt: adoptedController.lastAuthenticatedAt,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		},
	}
}
