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
	getBondTokenSecret,
	listBondBridges,
	pruneNonAdoptedBondBridges,
	releaseBondBridge,
	requireBondBridge,
	saveBondToken,
	updateBondBridgeConnection,
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
	const message = error.message.toLowerCase()
	if (
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
		causeMessage.includes('getaddrinfo')
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

function getBondTransientRetryDelayMs(attempt: number) {
	return defaultBondTransientRetryBaseDelayMs * 2 ** Math.max(0, attempt - 1)
}

async function wait(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms))
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
		return await withBondBridgeRequest({
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
		async fetchBridgeVersion(bridgeId?: string) {
			const bridge = resolveBridge(bridgeId)
			return await withBondBridgeRequest({
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
			const raw = (await withBondBridgeRequest({
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
			const raw = (await withBondBridgeRequest({
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
			return await withBondBridgeRequest({
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
			return await withBondBridgeRequest({
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
			const doc = await withBondBridgeRequest({
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
			return await withBondBridgeRequest({
				bridge,
				operation: `invoke device ${deviceId} action ${input.action}`,
				request: async (baseUrl) =>
					await bondInvokeDeviceAction({
						baseUrl,
						token,
						deviceId,
						action: input.action,
						argument: input.argument,
					}),
			})
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
			return await withBondBridgeRequest({
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
			return await withBondBridgeRequest({
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
			return await withBondBridgeRequest({
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
			const doc = await withBondBridgeRequest({
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
			return await withBondBridgeRequest({
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
