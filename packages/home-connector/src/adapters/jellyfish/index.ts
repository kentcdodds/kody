import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { sendJellyfishCommand } from './client.ts'
import { scanJellyfishControllers } from './discovery.ts'
import {
	getJellyfishController,
	listJellyfishControllers,
	updateJellyfishControllerConnection,
	upsertDiscoveredJellyfishControllers,
} from './repository.ts'
import {
	type JellyfishPattern,
	type JellyfishPatternData,
	type JellyfishPersistedController,
	type JellyfishZone,
} from './types.ts'

const defaultCommandTimeoutMs = 5_000

function controllerLabel(controller: JellyfishPersistedController) {
	return `${controller.name} (${controller.hostname})`
}

function getKnownControllers(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return listJellyfishControllers(storage, connectorId)
}

function parsePatternPath(patternPath: string) {
	const normalized = patternPath.trim()
	const separatorIndex = normalized.indexOf('/')
	if (separatorIndex <= 0 || separatorIndex === normalized.length - 1) {
		throw new Error(
			`Invalid JellyFish pattern path "${patternPath}". Use "<folder>/<pattern name>".`,
		)
	}
	return {
		path: normalized,
		folder: normalized.slice(0, separatorIndex),
		name: normalized.slice(separatorIndex + 1),
	}
}

function parseZonesResponse(
	response: Record<string, unknown>,
): Array<JellyfishZone> {
	const zones = response['zones']
	if (!zones || typeof zones !== 'object' || Array.isArray(zones)) {
		throw new Error(
			'JellyFish controller did not return a valid zones payload.',
		)
	}
	return Object.entries(zones as Record<string, unknown>)
		.map(([name, value]) => {
			const details =
				value && typeof value === 'object' && !Array.isArray(value)
					? (value as Record<string, unknown>)
					: {}
			return {
				name,
				numPixels:
					typeof details['numPixels'] === 'number' &&
					Number.isFinite(details['numPixels'])
						? details['numPixels']
						: null,
				portMap: Array.isArray(details['portMap'])
					? (details['portMap'] as Array<Record<string, unknown>>)
					: [],
			} satisfies JellyfishZone
		})
		.filter((zone) => zone.name.trim().length > 0)
		.sort((left, right) => left.name.localeCompare(right.name))
}

function parsePatternListResponse(
	response: Record<string, unknown>,
): Array<JellyfishPattern> {
	const patternFileList = response['patternFileList']
	if (!Array.isArray(patternFileList)) {
		throw new Error(
			'JellyFish controller did not return a valid patternFileList payload.',
		)
	}
	const patterns: Array<JellyfishPattern> = []
	let currentFolder = ''
	for (const entry of patternFileList) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		const record = entry as Record<string, unknown>
		const folder =
			typeof record['folders'] === 'string' ? record['folders'].trim() : ''
		const name = typeof record['name'] === 'string' ? record['name'].trim() : ''
		if (folder) currentFolder = folder
		if (!name || !currentFolder) continue
		patterns.push({
			path: `${currentFolder}/${name}`,
			folder: currentFolder,
			name,
			readOnly: Boolean(record['readOnly']),
		})
	}
	return patterns.sort((left, right) => left.path.localeCompare(right.path))
}

function parsePatternFileDataResponse(
	response: Record<string, unknown>,
): JellyfishPatternData {
	const patternFileData = response['patternFileData']
	if (
		!patternFileData ||
		typeof patternFileData !== 'object' ||
		Array.isArray(patternFileData)
	) {
		throw new Error(
			'JellyFish controller did not return a valid patternFileData payload.',
		)
	}
	const folder =
		typeof patternFileData['folders'] === 'string'
			? patternFileData['folders'].trim()
			: ''
	const name =
		typeof patternFileData['name'] === 'string'
			? patternFileData['name'].trim()
			: ''
	const rawJsonData =
		typeof patternFileData['jsonData'] === 'string'
			? patternFileData['jsonData']
			: ''
	if (!folder || !name || !rawJsonData) {
		throw new Error(
			'JellyFish controller returned incomplete patternFileData fields.',
		)
	}
	let data: Record<string, unknown>
	try {
		data = JSON.parse(rawJsonData) as Record<string, unknown>
	} catch (error) {
		throw new Error(
			`JellyFish pattern data is not valid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
	return {
		path: `${folder}/${name}`,
		folder,
		name,
		data,
		rawJsonData,
	}
}

function requireSingleController(
	controllers: Array<JellyfishPersistedController>,
) {
	if (controllers.length === 1) return controllers[0]!
	if (controllers.length === 0) {
		throw new Error(
			'No JellyFish controllers are currently known. Scan the local network first.',
		)
	}
	throw new Error(
		`Multiple JellyFish controllers are known: ${controllers.map(controllerLabel).join('; ')}.`,
	)
}

export function createJellyfishAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
}) {
	const { config, state, storage } = input
	const connectorId = config.homeConnectorId

	async function scanAndPersist() {
		const result = await scanJellyfishControllers(state, config)
		upsertDiscoveredJellyfishControllers({
			storage,
			connectorId,
			controllers: result.controllers,
		})
		return {
			controllers: getKnownControllers(storage, connectorId),
			diagnostics: result.diagnostics,
		}
	}

	async function resolveController() {
		const known = getKnownControllers(storage, connectorId)
		if (known.length === 1) return known[0]!

		const rescanned = await scanAndPersist()
		if (rescanned.controllers.length === 1) {
			return rescanned.controllers[0]!
		}
		return requireSingleController(rescanned.controllers)
	}

	function recordControllerConnection(input: {
		controllerId: string
		host: string
		port: number
		lastConnectedAt: string | null
		lastError: string | null
	}) {
		return updateJellyfishControllerConnection({
			storage,
			connectorId,
			controllerId: input.controllerId,
			host: input.host,
			port: input.port,
			lastConnectedAt: input.lastConnectedAt,
			lastError: input.lastError,
		})
	}

	async function sendWithResolvedController(input: {
		controller: JellyfishPersistedController
		command: Record<string, unknown>
		timeoutMs?: number
	}) {
		try {
			const response = await sendJellyfishCommand({
				host: input.controller.host,
				port: input.controller.port,
				command: input.command,
				timeoutMs: input.timeoutMs ?? defaultCommandTimeoutMs,
				mocksEnabled: config.mocksEnabled,
			})
			const now = new Date().toISOString()
			const controller =
				recordControllerConnection({
					controllerId: input.controller.controllerId,
					host: input.controller.host,
					port: input.controller.port,
					lastConnectedAt: now,
					lastError: null,
				}) ?? input.controller
			return {
				controller,
				response,
			}
		} catch (error) {
			recordControllerConnection({
				controllerId: input.controller.controllerId,
				host: input.controller.host,
				port: input.controller.port,
				lastConnectedAt: input.controller.lastConnectedAt,
				lastError: error instanceof Error ? error.message : String(error),
			})
			throw error
		}
	}

	async function executeResolvedCommand(input: {
		controller: JellyfishPersistedController
		command: Record<string, unknown>
		timeoutMs?: number
	}) {
		try {
			return await sendWithResolvedController(input)
		} catch (error) {
			const rescanned = await scanAndPersist()
			if (rescanned.controllers.length !== 1) {
				throw error
			}
			const retryController =
				getJellyfishController(
					storage,
					connectorId,
					rescanned.controllers[0]!.controllerId,
				) ?? rescanned.controllers[0]!
			if (
				retryController.controllerId === input.controller.controllerId &&
				retryController.host === input.controller.host &&
				retryController.port === input.controller.port
			) {
				throw error
			}
			return await sendWithResolvedController({
				...input,
				controller: retryController,
			})
		}
	}

	async function listZonesForController(input: {
		controller: JellyfishPersistedController
		timeoutMs?: number
	}) {
		const result = await executeResolvedCommand({
			controller: input.controller,
			command: {
				cmd: 'toCtlrGet',
				get: [['zones']],
			},
			timeoutMs: input.timeoutMs,
		})
		return {
			controller: result.controller,
			zones: parseZonesResponse(result.response),
		}
	}

	async function resolveZoneNames(input: {
		controller: JellyfishPersistedController
		zoneNames?: Array<string>
		timeoutMs?: number
	}) {
		const zoneResult = await listZonesForController({
			controller: input.controller,
			timeoutMs: input.timeoutMs,
		})
		const availableZoneNames = zoneResult.zones.map((zone) => zone.name)
		const requestedZoneNames =
			input.zoneNames?.map((zone) => zone.trim()).filter(Boolean) ?? []
		const zoneNames =
			requestedZoneNames.length > 0 ? requestedZoneNames : availableZoneNames
		if (zoneNames.length === 0) {
			throw new Error(
				'No JellyFish zones are available on the resolved controller.',
			)
		}
		const available = new Set(availableZoneNames)
		const missing = zoneNames.filter((zone) => !available.has(zone))
		if (missing.length > 0) {
			throw new Error(
				`Unknown JellyFish zone(s): ${missing.join(', ')}. Known zones: ${availableZoneNames.join(', ')}.`,
			)
		}
		return {
			controller: zoneResult.controller,
			zones: zoneResult.zones,
			zoneNames,
		}
	}

	return {
		async scan() {
			return (await scanAndPersist()).controllers
		},
		listControllers() {
			return getKnownControllers(storage, connectorId)
		},
		getStatus() {
			return {
				controllers: getKnownControllers(storage, connectorId),
				discovered: state.jellyfishDiscoveredControllers,
				diagnostics: state.jellyfishDiscoveryDiagnostics,
			}
		},
		async listZones(input?: { timeoutMs?: number }) {
			const controller = await resolveController()
			return await listZonesForController({
				controller,
				timeoutMs: input?.timeoutMs,
			})
		},
		async listPatterns(input?: { timeoutMs?: number }) {
			const controller = await resolveController()
			const result = await executeResolvedCommand({
				controller,
				command: {
					cmd: 'toCtlrGet',
					get: [['patternFileList']],
				},
				timeoutMs: input?.timeoutMs,
			})
			return {
				controller: result.controller,
				patterns: parsePatternListResponse(result.response),
			}
		},
		async getPattern(input: { patternPath: string; timeoutMs?: number }) {
			const controller = await resolveController()
			const pattern = parsePatternPath(input.patternPath)
			const result = await executeResolvedCommand({
				controller,
				command: {
					cmd: 'toCtlrGet',
					get: [['patternFileData', pattern.folder, pattern.name]],
				},
				timeoutMs: input.timeoutMs,
			})
			return {
				controller: result.controller,
				pattern: parsePatternFileDataResponse(result.response),
			}
		},
		async runPattern(input: {
			patternPath?: string
			patternData?: Record<string, unknown>
			zoneNames?: Array<string>
			state?: 'on' | 'off'
			timeoutMs?: number
		}) {
			const hasPatternPath =
				typeof input.patternPath === 'string' &&
				input.patternPath.trim().length > 0
			const hasPatternData =
				Boolean(input.patternData) &&
				typeof input.patternData === 'object' &&
				!Array.isArray(input.patternData)
			if (Number(hasPatternPath) + Number(hasPatternData) !== 1) {
				throw new Error(
					'Provide exactly one of patternPath or patternData for jellyfish_run_pattern.',
				)
			}
			const controller = await resolveController()
			const zoneResolution = await resolveZoneNames({
				controller,
				zoneNames: input.zoneNames,
				timeoutMs: input.timeoutMs,
			})
			const patternPath = hasPatternPath
				? parsePatternPath(input.patternPath!).path
				: ''
			const runPattern = {
				file: patternPath,
				data: hasPatternData ? JSON.stringify(input.patternData) : '',
				id: '',
				state: input.state === 'off' ? 0 : 1,
				zoneName: zoneResolution.zoneNames,
			}
			const result = await executeResolvedCommand({
				controller: zoneResolution.controller,
				command: {
					cmd: 'toCtlrSet',
					runPattern,
				},
				timeoutMs: input.timeoutMs,
			})
			return {
				controller: result.controller,
				zoneNames: zoneResolution.zoneNames,
				availableZones: zoneResolution.zones,
				runPattern:
					result.response['runPattern'] &&
					typeof result.response['runPattern'] === 'object' &&
					!Array.isArray(result.response['runPattern'])
						? (result.response['runPattern'] as Record<string, unknown>)
						: runPattern,
			}
		},
	}
}
