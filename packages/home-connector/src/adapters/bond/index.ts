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

	function bridgeBaseUrl(bridge: BondPersistedBridge) {
		return buildBondBaseUrl(bridge.host, bridge.port)
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
		const baseUrl = bridgeBaseUrl(bridge)
		const ids = await bondListDeviceIds({ baseUrl, token })
		const docs = await mapPool(ids, 8, async (id) => {
			const doc = await bondGetDevice({ baseUrl, token, deviceId: id })
			return summarizeDevice(id, doc)
		})
		return docs
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
			return await bondGetSysVersion({
				baseUrl: bridgeBaseUrl(bridge),
			})
		},
		async getTokenStatus(bridgeId?: string) {
			const bridge = resolveBridge(bridgeId)
			const existing = getBondTokenSecret(
				input.storage,
				connectorId,
				bridge.bridgeId,
			)
			const raw = (await bondGetTokenStatus({
				baseUrl: bridgeBaseUrl(bridge),
				token: existing,
			})) as Record<string, unknown>
			return stripTokenFields(raw)
		},
		async syncTokenFromBridge(bridgeId?: string) {
			const bridge = bridgeId
				? requireBondBridge(input.storage, connectorId, bridgeId)
				: resolveBridge()
			const raw = (await bondGetTokenStatus({
				baseUrl: bridgeBaseUrl(bridge),
				token: null,
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
			return await bondGetDevice({
				baseUrl: bridgeBaseUrl(bridge),
				token,
				deviceId,
			})
		},
		async getDeviceState(
			bridgeId: string | undefined,
			deviceId: string,
		): Promise<Record<string, unknown>> {
			const bridge = requireAdoptedBridge(bridgeId)
			const token = requireToken(bridge)
			return await bondGetDeviceState({
				baseUrl: bridgeBaseUrl(bridge),
				token,
				deviceId,
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
			const doc = await bondGetDevice({
				baseUrl: bridgeBaseUrl(bridge),
				token,
				deviceId,
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
			return await bondInvokeDeviceAction({
				baseUrl: bridgeBaseUrl(bridge),
				token,
				deviceId,
				action: input.action,
				argument: input.argument,
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
			const baseUrl = bridgeBaseUrl(bridge)
			const ids = await bondListGroupIds({ baseUrl, token })
			return await mapPool(ids, 6, async (groupId) => {
				const doc = await bondGetGroup({ baseUrl, token, groupId })
				return summarizeGroup(groupId, doc)
			})
		},
		async getGroup(bridgeId: string | undefined, groupId: string) {
			const bridge = requireAdoptedBridge(bridgeId)
			const token = requireToken(bridge)
			return await bondGetGroup({
				baseUrl: bridgeBaseUrl(bridge),
				token,
				groupId,
			})
		},
		async getGroupState(bridgeId: string | undefined, groupId: string) {
			const bridge = requireAdoptedBridge(bridgeId)
			const token = requireToken(bridge)
			return await bondGetGroupState({
				baseUrl: bridgeBaseUrl(bridge),
				token,
				groupId,
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
			const baseUrl = bridgeBaseUrl(bridge)
			const doc = await bondGetGroup({
				baseUrl,
				token,
				groupId: input.groupId,
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
			return await bondInvokeGroupAction({
				baseUrl,
				token,
				groupId: input.groupId,
				action: input.action,
				argument: input.argument,
			})
		},
	}
	return bondApi
}
