import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	bondGetDevice,
	bondGetDeviceState,
	bondGetGroup,
	bondGetGroupState,
	bondGetSysVersion,
	bondGetTokenStatus,
	bondInvokeDeviceAction,
	bondInvokeGroupAction,
	bondListDeviceIds,
	bondListGroupIds,
	buildBondBaseUrl,
} from './api-client.ts'
import { scanBondBridges } from './discovery.ts'
import {
	adoptBondBridge,
	clearBondReliabilityCooldown,
	getBondReliabilityState,
	getBondTokenSecret,
	insertBondRequestLog,
	listRecentBondRequestLogs,
	listBondBridges,
	pruneBondRequestLogs,
	pruneNonAdoptedBondBridges,
	releaseBondBridge,
	requireBondBridge,
	saveBondToken,
	saveBondReliabilityFailure,
	updateBondBridgeConnection,
	updateBondBridgeLastSeen,
	upsertDiscoveredBondBridges,
} from './repository.ts'
import {
	type BondDeviceSummary,
	type BondGroupSummary,
	type BondPersistedBridge,
} from './types.ts'
import { type HomeConnectorErrorCaptureContext } from '../../sentry.ts'

const defaultBondTransientAttemptsPerBaseUrl = 4
const defaultBondTransientRetryBaseDelayMs = 100
const bondRequestLogLimit = 200

type BondRequestLogStatus = 'success' | 'failure' | 'cooldown'

type BondQueueState = {
	tail: Promise<void>
	nextAvailableAt: number
	cooldownUntil: number
}

type BondStateReadCacheEntry = {
	promise: Promise<Record<string, unknown>>
}

function normalizeQuery(value: string) {
	return value.trim().toLowerCase()
}

async function mapPool<T, R>(
	items: Array<T>,
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<Array<R>> {
	const results: Array<R> = []
	for (let index = 0; index < items.length; index += limit) {
		const chunk = items.slice(index, index + limit)
		results.push(...(await Promise.all(chunk.map(fn))))
	}
	return results
}

function summarizeDevice(
	deviceId: string,
	doc: Record<string, unknown>,
): BondDeviceSummary {
	const actions = Array.isArray(doc['actions'])
		? (doc['actions'] as Array<unknown>).map((a) => String(a))
		: []
	return {
		deviceId,
		name: typeof doc['name'] === 'string' ? doc['name'] : deviceId,
		type: typeof doc['type'] === 'string' ? doc['type'] : '',
		location: typeof doc['location'] === 'string' ? doc['location'] : null,
		template: typeof doc['template'] === 'string' ? doc['template'] : null,
		subtype: typeof doc['subtype'] === 'string' ? doc['subtype'] : null,
		actions,
	}
}

function summarizeGroup(
	groupId: string,
	doc: Record<string, unknown>,
): BondGroupSummary {
	const actions = Array.isArray(doc['actions'])
		? (doc['actions'] as Array<unknown>).map((a) => String(a))
		: []
	const devices = Array.isArray(doc['devices'])
		? (doc['devices'] as Array<unknown>).map((d) => String(d))
		: []
	return {
		groupId,
		name: typeof doc['name'] === 'string' ? doc['name'] : groupId,
		devices,
		actions,
	}
}

function stripTokenFields(payload: Record<string, unknown>) {
	const copy = { ...payload }
	if ('token' in copy) delete copy['token']
	if ('v1_nonce' in copy) delete copy['v1_nonce']
	if ('nonce' in copy) delete copy['nonce']
	return copy
}

function getBridgeDiscoveredAddress(bridge: BondPersistedBridge) {
	const rawAddress = bridge.rawDiscovery?.['address']
	if (typeof rawAddress === 'string' && rawAddress.trim()) {
		return rawAddress.trim()
	}
	const mdns = bridge.rawDiscovery?.['mdns']
	if (mdns && typeof mdns === 'object' && !Array.isArray(mdns)) {
		const mdnsRecord = mdns as Record<string, unknown>
		const mdnsAddress = mdnsRecord['address']
		if (typeof mdnsAddress === 'string' && mdnsAddress.trim()) {
			return mdnsAddress.trim()
		}
		const mdnsAddresses = mdnsRecord['addresses']
		if (Array.isArray(mdnsAddresses)) {
			const firstAddress = mdnsAddresses.find(
				(entry) => typeof entry === 'string' && entry.trim(),
			)
			if (typeof firstAddress === 'string') {
				return firstAddress.trim()
			}
		}
	}
	return null
}

function getBondBridgeConnectionContext(bridge: BondPersistedBridge) {
	const discoveredAddress = getBridgeDiscoveredAddress(bridge)
	return {
		bridgeId: bridge.bridgeId,
		instanceName: bridge.instanceName,
		host: bridge.host,
		port: bridge.port,
		discoveredAddress,
		adopted: bridge.adopted,
		hasStoredToken: bridge.hasStoredToken,
		lastSeenAt: bridge.lastSeenAt,
	}
}

function createBondBaseUrlCandidates(bridge: BondPersistedBridge) {
	const primary = buildBondBaseUrl(bridge.host, bridge.port)
	const discoveredAddress = getBridgeDiscoveredAddress(bridge)
	if (!discoveredAddress) {
		return [primary]
	}
	const fallback = buildBondBaseUrl(discoveredAddress, bridge.port)
	return fallback === primary ? [primary] : [primary, fallback]
}

function getErrorCauseMessage(error: Error): string | null {
	const cause = error.cause
	if (cause instanceof Error) {
		return cause.message
	}
	if (typeof cause === 'string') {
		return cause
	}
	if (cause && typeof cause === 'object') {
		const message = (cause as { message?: unknown }).message
		if (typeof message === 'string' && message.trim()) {
			return message
		}
		if (message != null) {
			return String(message)
		}
	}
	return null
}

function getErrorMessages(error: unknown) {
	if (!(error instanceof Error)) {
		return [String(error)]
	}
	const messages = [error.message]
	const causeMessage = getErrorCauseMessage(error)
	if (causeMessage) {
		messages.push(causeMessage)
	}
	return messages
}

function isBondNetworkFailure(error: unknown) {
	if (!(error instanceof Error)) {
		return false
	}
	const errorName = error.name.toLowerCase()
	if (errorName === 'aborterror' || errorName === 'timeouterror') {
		return true
	}
	const message = error.message.toLowerCase()
	if (
		message.includes('bond request timed out') ||
		message.includes('fetch failed') ||
		message.includes('enotfound') ||
		message.includes('eai_again') ||
		message.includes('econnrefused') ||
		message.includes('econnreset') ||
		message.includes('ehostunreach') ||
		message.includes('etimedout')
	) {
		return true
	}
	const causeMessage = (getErrorCauseMessage(error) ?? '').toLowerCase()
	return (
		causeMessage.includes('enotfound') ||
		causeMessage.includes('eai_again') ||
		causeMessage.includes('econnrefused') ||
		causeMessage.includes('econnreset') ||
		causeMessage.includes('ehostunreach') ||
		causeMessage.includes('etimedout') ||
		causeMessage.includes('getaddrinfo') ||
		causeMessage.includes('the operation was aborted')
	)
}

function isBondTransientNetworkFailure(error: unknown) {
	if (!isBondNetworkFailure(error)) {
		return false
	}
	const messages = getErrorMessages(error).map((message) =>
		message.toLowerCase(),
	)
	return messages.some(
		(message) =>
			message.includes('econnreset') || message.includes('socket hang up'),
	)
}

function getBondNumericStateValue(state: Record<string, unknown>, key: string) {
	const rawValue = state[key]
	if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
		return rawValue
	}
	if (typeof rawValue === 'string' && rawValue.trim()) {
		const parsed = Number(rawValue)
		return Number.isFinite(parsed) ? parsed : null
	}
	return null
}

function isBondPositionStateReached(
	state: Record<string, unknown>,
	position: number,
) {
	const statePosition = getBondNumericStateValue(state, 'position')
	return (
		statePosition != null && Math.round(statePosition) === Math.round(position)
	)
}

function getBondTransientRetryDelayMs(attempt: number) {
	return defaultBondTransientRetryBaseDelayMs * 2 ** Math.max(0, attempt - 1)
}

async function wait(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

function nowIso() {
	return new Date().toISOString()
}

function formatBondFailureReason(error: unknown) {
	if (error instanceof Error) {
		const causeMessage = getErrorCauseMessage(error)
		return causeMessage
			? `${error.message}; cause=${causeMessage}`
			: error.message
	}
	return String(error)
}

function createBondCooldownError(input: {
	bridge: BondPersistedBridge
	operation: string
	cooldownUntil: number
}) {
	const cooldownUntilIso = new Date(input.cooldownUntil).toISOString()
	const error = new Error(
		`Bond bridge "${input.bridge.bridgeId}" is cooling down after a recent network failure; refusing to ${input.operation} until ${cooldownUntilIso}.`,
	) as Error & {
		homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext
	}
	error.name = 'BondCircuitBreakerError'
	error.homeConnectorCaptureContext = {
		tags: {
			connector_vendor: 'bond',
			bond_bridge_id: input.bridge.bridgeId,
			bond_network_failure: 'true',
			bond_circuit_breaker: 'true',
		},
		contexts: {
			bond_bridge: {
				...getBondBridgeConnectionContext(input.bridge),
				operation: input.operation,
				cooldownUntil: cooldownUntilIso,
			},
		},
		extra: {
			bondOperation: input.operation,
			bondCooldownUntil: cooldownUntilIso,
		},
	}
	return error
}

function createBondActionableError(input: {
	bridge: BondPersistedBridge
	operation: string
	error: unknown
	baseUrlsTried: Array<string>
}) {
	const connection = getBondBridgeConnectionContext(input.bridge)
	const failureReason = formatBondFailureReason(input.error)
	const guidance = connection.host.endsWith('.local')
		? ' The stored Bond host ends in .local, so this usually means the container cannot resolve mDNS on the LAN. If this connector runs in a NAS/container without mDNS, update the bridge host to a stable IP with bond_update_bridge_connection or restore mDNS/DNS visibility for the container.'
		: ' Verify the bridge host/IP is still reachable from the home-connector container and update it with bond_update_bridge_connection if it changed.'
	const errorMessage = `Bond bridge "${input.bridge.bridgeId}" could not be reached while trying to ${input.operation} at ${input.baseUrlsTried.join(', ')}. ${failureReason}.${guidance}`
	const wrappedError = new Error(errorMessage, {
		cause: input.error instanceof Error ? input.error : undefined,
	}) as Error & {
		homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext
	}
	wrappedError.name = 'BondRequestError'
	wrappedError.homeConnectorCaptureContext = {
		tags: {
			connector_vendor: 'bond',
			bond_bridge_id: input.bridge.bridgeId,
			bond_network_failure: isBondNetworkFailure(input.error)
				? 'true'
				: 'false',
			bond_host_is_local: input.bridge.host.endsWith('.local')
				? 'true'
				: 'false',
		},
		contexts: {
			bond_bridge: {
				...connection,
				baseUrlsTried: input.baseUrlsTried,
				operation: input.operation,
			},
		},
		extra: {
			bondOperation: input.operation,
			bondBaseUrlsTried: input.baseUrlsTried,
			bondFailureReason: failureReason,
		},
	}
	return wrappedError
}

async function withBondBridgeRequest<T>(input: {
	bridge: BondPersistedBridge
	operation: string
	request: (baseUrl: string) => Promise<T>
	maxTransientAttemptsPerBaseUrl?: number
	attemptedBaseUrls?: Array<string>
}) {
	const baseUrls = createBondBaseUrlCandidates(input.bridge)
	const attemptedBaseUrls: Array<string> = []
	let lastError: unknown = null
	const maxTransientAttemptsPerBaseUrl = Math.max(
		1,
		Math.floor(input.maxTransientAttemptsPerBaseUrl ?? 1),
	)
	for (let index = 0; index < baseUrls.length; index += 1) {
		const baseUrl = baseUrls[index]!
		attemptedBaseUrls.push(baseUrl)
		input.attemptedBaseUrls?.push(baseUrl)
		for (
			let attempt = 1;
			attempt <= maxTransientAttemptsPerBaseUrl;
			attempt += 1
		) {
			try {
				return await input.request(baseUrl)
			} catch (error) {
				lastError = error
				if (!isBondNetworkFailure(error)) {
					throw error
				}
				if (
					attempt < maxTransientAttemptsPerBaseUrl &&
					isBondTransientNetworkFailure(error)
				) {
					await wait(getBondTransientRetryDelayMs(attempt))
					continue
				}
				break
			}
		}
		const canRetryWithFallback = index === 0 && baseUrls.length > 1
		if (!canRetryWithFallback) {
			break
		}
	}
	throw createBondActionableError({
		bridge: input.bridge,
		operation: input.operation,
		error: lastError,
		baseUrlsTried: attemptedBaseUrls,
	})
}

export function createBondAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
}) {
	const connectorId = input.config.homeConnectorId
	const requestPaceMs = input.config.bondRequestPaceMs
	const circuitBreakerCooldownMs = input.config.bondCircuitBreakerCooldownMs
	const queueStates = new Map<string, BondQueueState>()
	const stateReadCache = new Map<string, BondStateReadCacheEntry>()

	function getQueueState(bridgeId: string) {
		let state = queueStates.get(bridgeId)
		if (!state) {
			state = {
				tail: Promise.resolve(),
				nextAvailableAt: 0,
				cooldownUntil: 0,
			}
			queueStates.set(bridgeId, state)
		}
		return state
	}

	function markBridgeSeen(bridge: BondPersistedBridge) {
		updateBondBridgeLastSeen({
			storage: input.storage,
			connectorId,
			bridgeId: bridge.bridgeId,
			lastSeenAt: new Date().toISOString(),
		})
	}

	function pruneRequestLogs(bridgeId: string) {
		pruneBondRequestLogs({
			storage: input.storage,
			connectorId,
			bridgeId,
			limit: bondRequestLogLimit,
		})
	}

	function runBestEffortPersistence(description: string, fn: () => void) {
		try {
			fn()
		} catch (error) {
			console.warn(`Bond reliability persistence failed: ${description}`, error)
		}
	}

	function writeRequestLog(inputLog: {
		bridge: BondPersistedBridge
		operation: string
		status: BondRequestLogStatus
		startedAt: string
		startedAtMs: number
		baseUrlsTried: Array<string>
		error?: unknown
	}) {
		const finishedAtMs = Date.now()
		const error =
			inputLog.error instanceof Error ? inputLog.error : undefined
		insertBondRequestLog(input.storage, {
			connectorId,
			bridgeId: inputLog.bridge.bridgeId,
			operation: inputLog.operation,
			status: inputLog.status,
			startedAt: inputLog.startedAt,
			finishedAt: nowIso(),
			durationMs: finishedAtMs - inputLog.startedAtMs,
			baseUrlsTried: inputLog.baseUrlsTried,
			errorName: error?.name ?? null,
			errorMessage:
				inputLog.error == null
					? null
					: formatBondFailureReason(inputLog.error),
			networkFailure: isBondNetworkFailure(inputLog.error),
		})
		pruneRequestLogs(inputLog.bridge.bridgeId)
	}

	function writeRequestLogBestEffort(
		inputLog: Parameters<typeof writeRequestLog>[0],
	) {
		runBestEffortPersistence('write request log', () => {
			writeRequestLog(inputLog)
		})
	}

	function syncPersistedCooldown(
		bridge: BondPersistedBridge,
		queueState: BondQueueState,
	) {
		const persisted = getBondReliabilityState(
			input.storage,
			connectorId,
			bridge.bridgeId,
		)
		if (!persisted?.cooldownUntil) return
		const persistedUntil = Date.parse(persisted.cooldownUntil)
		if (Number.isFinite(persistedUntil) && persistedUntil > Date.now()) {
			queueState.cooldownUntil = Math.max(
				queueState.cooldownUntil,
				persistedUntil,
			)
		}
	}

	async function runQueuedBondBridgeRequest<T>(
		requestInput: Parameters<typeof withBondBridgeRequest<T>>[0],
	) {
		const queueState = getQueueState(requestInput.bridge.bridgeId)
		const previousTail = queueState.tail
		let releaseQueue: () => void = () => {}
		queueState.tail = new Promise<void>((resolve) => {
			releaseQueue = resolve
		})

		await previousTail.catch(() => undefined)
		const startedAtMs = Date.now()
		const startedAt = new Date(startedAtMs).toISOString()
		const baseUrlsTried: Array<string> = []
		try {
			syncPersistedCooldown(requestInput.bridge, queueState)
			const now = Date.now()
			if (queueState.cooldownUntil > now) {
				const error = createBondCooldownError({
					bridge: requestInput.bridge,
					operation: requestInput.operation,
					cooldownUntil: queueState.cooldownUntil,
				})
				writeRequestLogBestEffort({
					bridge: requestInput.bridge,
					operation: requestInput.operation,
					status: 'cooldown',
					startedAt,
					startedAtMs,
					baseUrlsTried,
					error,
				})
				throw error
			}
			const waitMs = queueState.nextAvailableAt - now
			if (waitMs > 0) {
				await wait(waitMs)
			}
			const result = await withBondBridgeRequest({
				...requestInput,
				attemptedBaseUrls: baseUrlsTried,
			})
			runBestEffortPersistence('mark bridge seen', () => {
				markBridgeSeen(requestInput.bridge)
			})
			runBestEffortPersistence('clear reliability cooldown', () => {
				clearBondReliabilityCooldown({
					storage: input.storage,
					connectorId,
					bridgeId: requestInput.bridge.bridgeId,
				})
			})
			writeRequestLogBestEffort({
				bridge: requestInput.bridge,
				operation: requestInput.operation,
				status: 'success',
				startedAt,
				startedAtMs,
				baseUrlsTried,
			})
			return result
		} catch (error) {
			if (
				isBondNetworkFailure(error) &&
				(!(error instanceof Error) ||
					error.name !== 'BondCircuitBreakerError')
			) {
				const cooldownUntil = Date.now() + circuitBreakerCooldownMs
				queueState.cooldownUntil = Math.max(
					queueState.cooldownUntil,
					cooldownUntil,
				)
				runBestEffortPersistence('save reliability failure', () => {
					saveBondReliabilityFailure({
						storage: input.storage,
						connectorId,
						bridgeId: requestInput.bridge.bridgeId,
						cooldownUntil: new Date(queueState.cooldownUntil).toISOString(),
						failureAt: nowIso(),
						failureReason: formatBondFailureReason(error),
					})
				})
			}
			if (
				!(error instanceof Error) ||
				error.name !== 'BondCircuitBreakerError'
			) {
				writeRequestLogBestEffort({
					bridge: requestInput.bridge,
					operation: requestInput.operation,
					status: 'failure',
					startedAt,
					startedAtMs,
					baseUrlsTried,
					error,
				})
			}
			throw error
		} finally {
			queueState.nextAvailableAt = Date.now() + requestPaceMs
			releaseQueue()
		}
	}

	async function withTrackedBondBridgeRequest<T>(
		requestInput: Parameters<typeof withBondBridgeRequest<T>>[0],
	) {
		return await runQueuedBondBridgeRequest(requestInput)
	}

	function listPublicBridges(): Array<BondPersistedBridge> {
		return listBondBridges(input.storage, connectorId)
	}

	function resolveBridge(bridgeId?: string): BondPersistedBridge {
		if (bridgeId) {
			return requireBondBridge(input.storage, connectorId, bridgeId)
		}
		const adopted = listPublicBridges().filter((bridge) => bridge.adopted)
		if (adopted.length === 1) return adopted[0]
		const all = listPublicBridges()
		if (all.length === 1) return all[0]
		if (adopted.length > 1 || all.length > 1) {
			throw new Error(
				'Multiple Bond bridges are available. Specify a bridgeId.',
			)
		}
		throw new Error(
			'No Bond bridges are currently known. Run bond_scan_bridges first.',
		)
	}

	function requireAdoptedBridge(bridgeId?: string): BondPersistedBridge {
		const bridge = resolveBridge(bridgeId)
		if (!bridge.adopted) {
			throw new Error(
				`Bond bridge "${bridge.bridgeId}" must be adopted before control.`,
			)
		}
		return bridge
	}

	function requireToken(bridge: BondPersistedBridge) {
		const token = getBondTokenSecret(
			input.storage,
			connectorId,
			bridge.bridgeId,
		)
		if (!token) {
			throw new Error(
				`Bond bridge "${bridge.bridgeId}" is missing a stored token. Save one in the home connector admin UI (/bond/setup), or call bond_authentication_guide for full steps.`,
			)
		}
		return token
	}

	async function resolveDeviceId(
		bridge: BondPersistedBridge,
		token: string,
		deviceId?: string,
		deviceName?: string,
	) {
		if (deviceId) return deviceId
		if (!deviceName) {
			throw new Error('Specify deviceId or deviceName.')
		}
		const devices = await listDeviceSummaries(bridge, token)
		const normalized = normalizeQuery(deviceName)
		const exact = devices.find(
			(device) => normalizeQuery(device.name) === normalized,
		)
		if (exact) return exact.deviceId

		const substringMatches = devices.filter((device) =>
			normalizeQuery(device.name).includes(normalized),
		)
		if (substringMatches.length === 1) {
			return substringMatches[0].deviceId
		}
		if (substringMatches.length > 1) {
			const sample = substringMatches
				.slice(0, 12)
				.map((device) => device.name)
				.join('; ')
			const extra =
				substringMatches.length > 12
					? ` (+${String(substringMatches.length - 12)} more)`
					: ''
			throw new Error(
				`Multiple Bond devices matched "${deviceName}": ${sample}${extra}. Pass deviceId.`,
			)
		}
		throw new Error(`No Bond device matched name "${deviceName}".`)
	}

	async function listDeviceSummaries(
		bridge: BondPersistedBridge,
		token: string,
	) {
		return await withTrackedBondBridgeRequest({
			bridge,
			operation: 'list devices',
			request: async (baseUrl) => {
				const ids = await bondListDeviceIds({ baseUrl, token })
				const docs = await mapPool(ids, 8, async (id) => {
					const doc = await bondGetDevice({ baseUrl, token, deviceId: id })
					return summarizeDevice(id, doc)
				})
				return docs
			},
		})
	}

	function readDeviceStateWithCoalescing(
		bridge: BondPersistedBridge,
		token: string,
		deviceId: string,
	) {
		const cacheKey = `${bridge.bridgeId}:${deviceId}`
		const cached = stateReadCache.get(cacheKey)
		if (cached) {
			return cached.promise
		}
		const promise = withTrackedBondBridgeRequest({
			bridge,
			operation: `fetch device ${deviceId} state`,
			maxTransientAttemptsPerBaseUrl: defaultBondTransientAttemptsPerBaseUrl,
			request: async (baseUrl) =>
				await bondGetDeviceState({
					baseUrl,
					token,
					deviceId,
				}),
		})
		stateReadCache.set(cacheKey, {
			promise,
		})
		const cleanup = () => {
			const current = stateReadCache.get(cacheKey)
			if (current?.promise === promise) {
				stateReadCache.delete(cacheKey)
			}
		}
		promise.then(cleanup, cleanup)
		return promise
	}

	const bondApi = {
		getStatus() {
			const bridges = listPublicBridges()
			return {
				bridges,
				diagnostics: input.state.bondDiscoveryDiagnostics,
				adopted: bridges.filter((bridge) => bridge.adopted),
				discovered: bridges.filter((bridge) => !bridge.adopted),
			}
		},
		async scan() {
			const discovered = await scanBondBridges(input.state, input.config)
			upsertDiscoveredBondBridges(input.storage, connectorId, discovered)
			return listPublicBridges()
		},
		adoptBridge(bridgeId: string) {
			return adoptBondBridge(input.storage, connectorId, bridgeId)
		},
		releaseBridge(bridgeId: string) {
			releaseBondBridge(input.storage, connectorId, bridgeId)
		},
		pruneDiscoveredBridges() {
			pruneNonAdoptedBondBridges(input.storage, connectorId)
			return listPublicBridges()
		},
		setToken(bridgeId: string, token: string) {
			requireBondBridge(input.storage, connectorId, bridgeId)
			saveBondToken({
				storage: input.storage,
				connectorId,
				bridgeId,
				token: token.trim(),
				lastVerifiedAt: new Date().toISOString(),
				lastAuthError: null,
			})
			return requireBondBridge(input.storage, connectorId, bridgeId)
		},
		updateBridgeConnection(
			bridgeId: string,
			connection: { host: string; port?: number },
		) {
			return updateBondBridgeConnection(
				input.storage,
				connectorId,
				bridgeId,
				connection,
			)
		},
		getReliabilityStatus(inputStatus: {
			bridgeId?: string
			limit?: number
		} = {}) {
			const bridge = resolveBridge(inputStatus.bridgeId)
			const queueState = getQueueState(bridge.bridgeId)
			syncPersistedCooldown(bridge, queueState)
			const limit =
				inputStatus.limit == null
					? 50
					: Math.max(1, Math.min(200, Math.floor(inputStatus.limit)))
			return {
				config: {
					requestPaceMs,
					circuitBreakerCooldownMs,
					coalescesInFlightStateReads: true,
				},
				queue: {
					nextAvailableAt:
						queueState.nextAvailableAt > 0
							? new Date(queueState.nextAvailableAt).toISOString()
							: null,
					cooldownUntil:
						queueState.cooldownUntil > 0
							? new Date(queueState.cooldownUntil).toISOString()
							: null,
				},
				persisted: getBondReliabilityState(
					input.storage,
					connectorId,
					bridge.bridgeId,
				),
				recentRequestLogs: listRecentBondRequestLogs({
					storage: input.storage,
					connectorId,
					bridgeId: bridge.bridgeId,
					limit,
				}),
			}
		},
		async fetchBridgeVersion(bridgeId?: string) {
			const bridge = resolveBridge(bridgeId)
			return await withTrackedBondBridgeRequest({
				bridge,
				operation: 'fetch bridge version',
				request: async (baseUrl) => await bondGetSysVersion({ baseUrl }),
			})
		},
		async getTokenStatus(bridgeId?: string) {
			const bridge = resolveBridge(bridgeId)
			const existing = getBondTokenSecret(
				input.storage,
				connectorId,
				bridge.bridgeId,
			)
			const raw = (await withTrackedBondBridgeRequest({
				bridge,
				operation: 'read token status',
				request: async (baseUrl) =>
					await bondGetTokenStatus({
						baseUrl,
						token: existing,
					}),
			})) as Record<string, unknown>
			return stripTokenFields(raw)
		},
		async syncTokenFromBridge(bridgeId?: string) {
			const bridge = bridgeId
				? requireBondBridge(input.storage, connectorId, bridgeId)
				: resolveBridge()
			const raw = (await withTrackedBondBridgeRequest({
				bridge,
				operation: 'retrieve token from bridge',
				request: async (baseUrl) =>
					await bondGetTokenStatus({
						baseUrl,
						token: null,
					}),
			})) as Record<string, unknown>
			const token =
				typeof raw['token'] === 'string' ? (raw['token'] as string) : null
			if (!token) {
				throw new Error(
					'Bond did not return a token (endpoint may be locked). Unlock in the Bond app or power-cycle the bridge and retry.',
				)
			}
			saveBondToken({
				storage: input.storage,
				connectorId,
				bridgeId: bridge.bridgeId,
				token,
				lastVerifiedAt: new Date().toISOString(),
				lastAuthError: null,
			})
			return { bridgeId: bridge.bridgeId, stored: true }
		},
		async listDevices(bridgeId?: string) {
			const bridge = requireAdoptedBridge(bridgeId)
			const token = requireToken(bridge)
			return await listDeviceSummaries(bridge, token)
		},
		async getDevice(
			bridgeId: string | undefined,
			deviceId: string,
		): Promise<Record<string, unknown>> {
			const bridge = requireAdoptedBridge(bridgeId)
			const token = requireToken(bridge)
			return await withTrackedBondBridgeRequest({
				bridge,
				operation: `fetch device ${deviceId}`,
				request: async (baseUrl) =>
					await bondGetDevice({
						baseUrl,
						token,
						deviceId,
					}),
			})
		},
		async getDeviceState(
			bridgeId: string | undefined,
			deviceId: string,
		): Promise<Record<string, unknown>> {
			const bridge = requireAdoptedBridge(bridgeId)
			const token = requireToken(bridge)
			return await readDeviceStateWithCoalescing(bridge, token, deviceId)
		},
		async invokeDeviceAction(input: {
			bridgeId?: string
			deviceId?: string
			deviceName?: string
			action: string
			argument?: number | string | boolean | null
		}) {
			const bridge = requireAdoptedBridge(input.bridgeId)
			const token = requireToken(bridge)
			const deviceId = await resolveDeviceId(
				bridge,
				token,
				input.deviceId,
				input.deviceName,
			)
			const doc = await withTrackedBondBridgeRequest({
				bridge,
				operation: `fetch device ${deviceId} before action`,
				request: async (baseUrl) =>
					await bondGetDevice({
						baseUrl,
						token,
						deviceId,
					}),
			})
			const rawActions = doc['actions']
			if (!Array.isArray(rawActions) || rawActions.length === 0) {
				throw new Error(
					`Bond device "${deviceId}" returned no usable actions list; refusing unvalidated invoke. Use bond_get_device to inspect this device.`,
				)
			}
			const actions = new Set(rawActions.map((entry) => String(entry)))
			if (!actions.has(input.action)) {
				throw new Error(
					`Device "${deviceId}" does not advertise action "${input.action}".`,
				)
			}
			const operation = `invoke device ${deviceId} action ${input.action}`
			try {
				return await withTrackedBondBridgeRequest({
					bridge,
					operation,
					request: async (baseUrl) =>
						await bondInvokeDeviceAction({
							baseUrl,
							token,
							deviceId,
							action: input.action,
							argument: input.argument,
						}),
				})
			} catch (error) {
				if (
					input.action === 'SetPosition' &&
					typeof input.argument === 'number' &&
					isBondTransientNetworkFailure(error)
				) {
					try {
						const state = await bondApi.getDeviceState(
							bridge.bridgeId,
							deviceId,
						)
						if (isBondPositionStateReached(state, input.argument)) {
							return {
								confirmed: true,
								recoveredFrom: 'transient_action_network_failure',
								state,
							}
						}
					} catch {
						// Preserve the action failure; the follow-up read is only diagnostic.
					}
				}
				throw error
			}
		},
		async shadeOpen(input: {
			bridgeId?: string
			deviceId?: string
			deviceName?: string
		}) {
			return await bondApi.invokeDeviceAction({
				bridgeId: input.bridgeId,
				deviceId: input.deviceId,
				deviceName: input.deviceName,
				action: 'Open',
			})
		},
		async shadeClose(input: {
			bridgeId?: string
			deviceId?: string
			deviceName?: string
		}) {
			return await bondApi.invokeDeviceAction({
				bridgeId: input.bridgeId,
				deviceId: input.deviceId,
				deviceName: input.deviceName,
				action: 'Close',
			})
		},
		async shadeStop(input: {
			bridgeId?: string
			deviceId?: string
			deviceName?: string
		}) {
			return await bondApi.invokeDeviceAction({
				bridgeId: input.bridgeId,
				deviceId: input.deviceId,
				deviceName: input.deviceName,
				action: 'Stop',
			})
		},
		async shadeSetPosition(input: {
			bridgeId?: string
			deviceId?: string
			deviceName?: string
			position: number
		}) {
			return await bondApi.invokeDeviceAction({
				bridgeId: input.bridgeId,
				deviceId: input.deviceId,
				deviceName: input.deviceName,
				action: 'SetPosition',
				argument: input.position,
			})
		},
		async listGroups(bridgeId?: string) {
			const bridge = requireAdoptedBridge(bridgeId)
			const token = requireToken(bridge)
			return await withTrackedBondBridgeRequest({
				bridge,
				operation: 'list groups',
				request: async (baseUrl) => {
					const ids = await bondListGroupIds({ baseUrl, token })
					return await mapPool(ids, 6, async (groupId) => {
						const doc = await bondGetGroup({ baseUrl, token, groupId })
						return summarizeGroup(groupId, doc)
					})
				},
			})
		},
		async getGroup(bridgeId: string | undefined, groupId: string) {
			const bridge = requireAdoptedBridge(bridgeId)
			const token = requireToken(bridge)
			return await withTrackedBondBridgeRequest({
				bridge,
				operation: `fetch group ${groupId}`,
				request: async (baseUrl) =>
					await bondGetGroup({
						baseUrl,
						token,
						groupId,
					}),
			})
		},
		async getGroupState(bridgeId: string | undefined, groupId: string) {
			const bridge = requireAdoptedBridge(bridgeId)
			const token = requireToken(bridge)
			return await withTrackedBondBridgeRequest({
				bridge,
				operation: `fetch group ${groupId} state`,
				request: async (baseUrl) =>
					await bondGetGroupState({
						baseUrl,
						token,
						groupId,
					}),
			})
		},
		async invokeGroupAction(input: {
			bridgeId?: string
			groupId: string
			action: string
			argument?: number | string | boolean | null
		}) {
			const bridge = requireAdoptedBridge(input.bridgeId)
			const token = requireToken(bridge)
			const doc = await withTrackedBondBridgeRequest({
				bridge,
				operation: `fetch group ${input.groupId} before action`,
				request: async (baseUrl) =>
					await bondGetGroup({
						baseUrl,
						token,
						groupId: input.groupId,
					}),
			})
			const rawActions = doc['actions']
			if (!Array.isArray(rawActions) || rawActions.length === 0) {
				throw new Error(
					`Bond group "${input.groupId}" returned no usable actions list; refusing unvalidated invoke. Use bond_get_group to inspect this group.`,
				)
			}
			const actions = new Set(rawActions.map((entry) => String(entry)))
			if (!actions.has(input.action)) {
				throw new Error(
					`Group "${input.groupId}" does not advertise action "${input.action}".`,
				)
			}
			return await withTrackedBondBridgeRequest({
				bridge,
				operation: `invoke group ${input.groupId} action ${input.action}`,
				request: async (baseUrl) =>
					await bondInvokeGroupAction({
						baseUrl,
						token,
						groupId: input.groupId,
						action: input.action,
						argument: input.argument,
					}),
			})
		},
	}
	return bondApi
}
