/**
 * Tesla Backup Gateway 2 / Powerwall+ leader adapter.
 *
 * Surface area mirrors the lutron adapter:
 *   - `scan()` runs a discovery sweep and persists the result.
 *   - `setCredentials()` stores an encrypted customer-role password keyed on
 *     the `HOME_CONNECTOR_SHARED_SECRET`.
 *   - `getLiveSnapshot()` fetches every customer-scope endpoint in one call,
 *     using a cached cookie session when available.
 *   - `findExportLimit()` is a small convenience that surfaces the most
 *     likely "site export cap" value from `site_info` / `system_status` for
 *     debugging curtailment.
 *
 * Hosts ending in `.mock.local` are dispatched to the in-process mock driver
 * so dev/test runs never touch the network.
 */
import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { scanTeslaGateways } from './discovery.ts'
import {
	clearTeslaGatewayRateLimits,
	extractGatewaySerialFromDin,
	getTeslaApiStatus,
	getTeslaGenerators,
	getTeslaGridStatus,
	getTeslaMetersAggregates,
	getTeslaNetworks,
	getTeslaOperation,
	getTeslaPowerwalls,
	getTeslaSiteInfo,
	getTeslaSoe,
	getTeslaSolarPowerwall,
	getTeslaSystemStatus,
	getTeslaSystemUpdateStatus,
	loginToTeslaGateway,
	TeslaGatewayHttpError,
	TeslaGatewayRateLimitError,
	type TeslaGatewaySession,
} from './gateway-client.ts'
import {
	getMockTeslaApiStatus,
	getMockTeslaGenerators,
	getMockTeslaGridStatus,
	getMockTeslaMetersAggregates,
	getMockTeslaNetworks,
	getMockTeslaOperation,
	getMockTeslaPowerwalls,
	getMockTeslaSiteInfo,
	getMockTeslaSoe,
	getMockTeslaSolarPowerwall,
	getMockTeslaSystemStatus,
	getMockTeslaSystemUpdateStatus,
	isMockTeslaGatewayHost,
	listMockTeslaGatewayDiscoveryEntries,
	validateMockTeslaCredentials,
} from './mock-driver.ts'
import {
	listPublicTeslaGateways,
	listTeslaGateways,
	requireTeslaGateway,
	saveTeslaGatewayCredentials,
	setTeslaGatewayLabel,
	toPublicTeslaGateway,
	updateTeslaGatewayAuthStatus,
	updateTeslaGatewayMetadata,
	upsertDiscoveredTeslaGateways,
} from './repository.ts'
import {
	type TeslaGatewayLiveSnapshot,
	type TeslaGatewayPersistedRecord,
	type TeslaGatewayPublicRecord,
} from './types.ts'

type SessionCacheEntry = {
	session: TeslaGatewaySession
	expiresAt: number
}

const sessionCache = new Map<string, SessionCacheEntry>()
const SESSION_TTL_MS = 23 * 60 * 60 * 1_000

function cacheKey(connectorId: string, gatewayId: string) {
	return `${connectorId}:${gatewayId}`
}

function getCachedSession(
	connectorId: string,
	gatewayId: string,
): TeslaGatewaySession | null {
	const entry = sessionCache.get(cacheKey(connectorId, gatewayId))
	if (!entry) return null
	if (entry.expiresAt < Date.now()) {
		sessionCache.delete(cacheKey(connectorId, gatewayId))
		return null
	}
	return entry.session
}

function storeSession(
	connectorId: string,
	gatewayId: string,
	session: TeslaGatewaySession,
) {
	sessionCache.set(cacheKey(connectorId, gatewayId), {
		session,
		expiresAt: Date.now() + SESSION_TTL_MS,
	})
}

function dropSession(connectorId: string, gatewayId: string) {
	sessionCache.delete(cacheKey(connectorId, gatewayId))
}

/**
 * Test helper. Clears every cached cookie and rate-limit cooldown so suites
 * can drive deterministic login flows.
 */
export function resetTeslaGatewayCaches() {
	sessionCache.clear()
	clearTeslaGatewayRateLimits()
}

function requireCredentials(gateway: TeslaGatewayPersistedRecord) {
	if (!gateway.password) {
		throw new Error(
			`Tesla gateway "${gateway.gatewayId}" is missing stored credentials. Run tesla_gateway_set_credentials first.`,
		)
	}
	return {
		emailLabel: gateway.customerEmailLabel,
		password: gateway.password,
	}
}

async function ensureSession(input: {
	storage: HomeConnectorStorage
	connectorId: string
	gateway: TeslaGatewayPersistedRecord
}): Promise<TeslaGatewaySession> {
	const cached = getCachedSession(input.connectorId, input.gateway.gatewayId)
	if (cached) return cached
	const credentials = requireCredentials(input.gateway)
	if (isMockTeslaGatewayHost(input.gateway.host)) {
		const ok = validateMockTeslaCredentials({
			host: input.gateway.host,
			emailLabel: credentials.emailLabel,
			password: credentials.password,
		})
		if (!ok) {
			throw new Error(
				'Tesla mock authentication failed because the credentials are invalid.',
			)
		}
		const session: TeslaGatewaySession = {
			host: input.gateway.host,
			port: input.gateway.port,
			cookieHeader: 'AuthCookie=mock; UserRecord=mock',
			token: 'mock-token',
		}
		storeSession(input.connectorId, input.gateway.gatewayId, session)
		updateTeslaGatewayAuthStatus({
			storage: input.storage,
			connectorId: input.connectorId,
			gatewayId: input.gateway.gatewayId,
			lastAuthenticatedAt: new Date().toISOString(),
			lastAuthError: null,
		})
		return session
	}
	const login = await loginToTeslaGateway({
		host: input.gateway.host,
		port: input.gateway.port,
		credentials,
	})
	const session: TeslaGatewaySession = {
		host: input.gateway.host,
		port: input.gateway.port,
		cookieHeader: login.cookieHeader,
		token: login.token,
	}
	storeSession(input.connectorId, input.gateway.gatewayId, session)
	updateTeslaGatewayAuthStatus({
		storage: input.storage,
		connectorId: input.connectorId,
		gatewayId: input.gateway.gatewayId,
		lastAuthenticatedAt: new Date().toISOString(),
		lastAuthError: null,
	})
	return session
}

async function safeFetch<T>(input: {
	label: string
	fn: () => Promise<T>
	onUnauthorized?: () => Promise<T>
	errors: Record<string, string>
}): Promise<T | null> {
	try {
		return await input.fn()
	} catch (error) {
		if (
			input.onUnauthorized &&
			error instanceof TeslaGatewayHttpError &&
			(error.status === 401 || error.status === 403)
		) {
			try {
				return await input.onUnauthorized()
			} catch (retryError) {
				input.errors[input.label] =
					retryError instanceof Error ? retryError.message : String(retryError)
				return null
			}
		}
		input.errors[input.label] =
			error instanceof Error ? error.message : String(error)
		return null
	}
}

async function fetchLiveFromGateway(input: {
	storage: HomeConnectorStorage
	connectorId: string
	gateway: TeslaGatewayPersistedRecord
}): Promise<TeslaGatewayLiveSnapshot> {
	const errors: Record<string, string> = {}
	let session = await ensureSession({
		storage: input.storage,
		connectorId: input.connectorId,
		gateway: input.gateway,
	})

	const isMock = isMockTeslaGatewayHost(input.gateway.host)
	async function retryAfterUnauthorized<T>(
		fn: (session: TeslaGatewaySession) => Promise<T>,
	): Promise<T> {
		dropSession(input.connectorId, input.gateway.gatewayId)
		const freshSession = await ensureSession({
			storage: input.storage,
			connectorId: input.connectorId,
			gateway: input.gateway,
		})
		session = freshSession
		return await fn(session)
	}
	const status = isMock
		? await safeFetch({
				label: 'status',
				fn: async () => getMockTeslaApiStatus(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'status',
				fn: () => getTeslaApiStatus(session),
				onUnauthorized: () => retryAfterUnauthorized(getTeslaApiStatus),
				errors,
			})
	const systemStatus = isMock
		? await safeFetch({
				label: 'system_status',
				fn: async () => getMockTeslaSystemStatus(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'system_status',
				fn: () => getTeslaSystemStatus(session),
				onUnauthorized: () => retryAfterUnauthorized(getTeslaSystemStatus),
				errors,
			})
	const gridStatus = isMock
		? await safeFetch({
				label: 'grid_status',
				fn: async () => getMockTeslaGridStatus(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'grid_status',
				fn: () => getTeslaGridStatus(session),
				onUnauthorized: () => retryAfterUnauthorized(getTeslaGridStatus),
				errors,
			})
	const soe = isMock
		? await safeFetch({
				label: 'soe',
				fn: async () => getMockTeslaSoe(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'soe',
				fn: () => getTeslaSoe(session),
				onUnauthorized: () => retryAfterUnauthorized(getTeslaSoe),
				errors,
			})
	const meters = isMock
		? await safeFetch({
				label: 'meters/aggregates',
				fn: async () => getMockTeslaMetersAggregates(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'meters/aggregates',
				fn: () => getTeslaMetersAggregates(session),
				onUnauthorized: () => retryAfterUnauthorized(getTeslaMetersAggregates),
				errors,
			})
	const operation = isMock
		? await safeFetch({
				label: 'operation',
				fn: async () => getMockTeslaOperation(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'operation',
				fn: () => getTeslaOperation(session),
				onUnauthorized: () => retryAfterUnauthorized(getTeslaOperation),
				errors,
			})
	const networks = isMock
		? await safeFetch({
				label: 'networks',
				fn: async () => getMockTeslaNetworks(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'networks',
				fn: () => getTeslaNetworks(session),
				onUnauthorized: () => retryAfterUnauthorized(getTeslaNetworks),
				errors,
			})
	const siteInfo = isMock
		? await safeFetch({
				label: 'site_info',
				fn: async () => getMockTeslaSiteInfo(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'site_info',
				fn: () => getTeslaSiteInfo(session),
				onUnauthorized: () => retryAfterUnauthorized(getTeslaSiteInfo),
				errors,
			})
	const powerwalls = isMock
		? await safeFetch({
				label: 'powerwalls',
				fn: async () => getMockTeslaPowerwalls(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'powerwalls',
				fn: () => getTeslaPowerwalls(session),
				onUnauthorized: () => retryAfterUnauthorized(getTeslaPowerwalls),
				errors,
			})
	const solarPowerwall = isMock
		? await safeFetch({
				label: 'solar_powerwall',
				fn: async () => getMockTeslaSolarPowerwall(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'solar_powerwall',
				fn: () => getTeslaSolarPowerwall(session),
				onUnauthorized: () => retryAfterUnauthorized(getTeslaSolarPowerwall),
				errors,
			})
	const generators = isMock
		? await safeFetch({
				label: 'generators',
				fn: async () => getMockTeslaGenerators(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'generators',
				fn: () => getTeslaGenerators(session),
				onUnauthorized: () => retryAfterUnauthorized(getTeslaGenerators),
				errors,
			})
	const systemUpdateStatus = isMock
		? await safeFetch({
				label: 'system/update/status',
				fn: async () => getMockTeslaSystemUpdateStatus(input.gateway.host),
				errors,
			})
		: await safeFetch({
				label: 'system/update/status',
				fn: () => getTeslaSystemUpdateStatus(session),
				onUnauthorized: () =>
					retryAfterUnauthorized(getTeslaSystemUpdateStatus),
				errors,
			})

	if (status?.din || status?.version) {
		updateTeslaGatewayMetadata({
			storage: input.storage,
			connectorId: input.connectorId,
			gatewayId: input.gateway.gatewayId,
			din: status?.din ?? null,
			serialNumber: extractGatewaySerialFromDin(status?.din ?? null),
			firmwareVersion: status?.version ?? null,
		})
	}

	const refreshed = requireTeslaGateway(
		input.storage,
		input.connectorId,
		input.gateway.gatewayId,
	)

	return {
		gateway: toPublicTeslaGateway(refreshed),
		status,
		systemStatus,
		gridStatus,
		soe,
		meters,
		operation,
		networks,
		siteInfo,
		powerwalls,
		solarPowerwall,
		generators,
		systemUpdateStatus,
		fetchErrors: errors,
	}
}

export type TeslaGatewayExportLimitInfo = {
	gatewayId: string
	siteName: string | null
	exportLimitWatts: number | null
	exportLimitKw: number | null
	source:
		| 'site_info.max_site_export_power_kW'
		| 'site_info.max_site_meter_power_ac'
		| 'system_status.solar_real_power_limit'
		| 'site_info.max_system_power_kW'
		| 'unknown'
}

function pickExportLimit(
	snapshot: TeslaGatewayLiveSnapshot,
): TeslaGatewayExportLimitInfo {
	const siteName =
		typeof snapshot.siteInfo?.site_name === 'string'
			? snapshot.siteInfo.site_name
			: null
	if (typeof snapshot.siteInfo?.max_site_export_power_kW === 'number') {
		const kW = snapshot.siteInfo.max_site_export_power_kW
		return {
			gatewayId: snapshot.gateway.gatewayId,
			siteName,
			exportLimitWatts: Math.round(kW * 1_000),
			exportLimitKw: kW,
			source: 'site_info.max_site_export_power_kW',
		}
	}
	if (typeof snapshot.siteInfo?.max_site_meter_power_ac === 'number') {
		const watts = snapshot.siteInfo.max_site_meter_power_ac
		return {
			gatewayId: snapshot.gateway.gatewayId,
			siteName,
			exportLimitWatts: watts,
			exportLimitKw: Math.round((watts / 1_000) * 100) / 100,
			source: 'site_info.max_site_meter_power_ac',
		}
	}
	if (typeof snapshot.systemStatus?.solar_real_power_limit === 'number') {
		const watts = snapshot.systemStatus.solar_real_power_limit
		return {
			gatewayId: snapshot.gateway.gatewayId,
			siteName,
			exportLimitWatts: watts,
			exportLimitKw: Math.round((watts / 1_000) * 100) / 100,
			source: 'system_status.solar_real_power_limit',
		}
	}
	if (typeof snapshot.siteInfo?.max_system_power_kW === 'number') {
		const kW = snapshot.siteInfo.max_system_power_kW
		return {
			gatewayId: snapshot.gateway.gatewayId,
			siteName,
			exportLimitWatts: Math.round(kW * 1_000),
			exportLimitKw: kW,
			source: 'site_info.max_system_power_kW',
		}
	}
	return {
		gatewayId: snapshot.gateway.gatewayId,
		siteName,
		exportLimitWatts: null,
		exportLimitKw: null,
		source: 'unknown',
	}
}

export function createTeslaGatewayAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
}) {
	const { config, state, storage } = input
	const connectorId = config.homeConnectorId

	function listGateways() {
		return listPublicTeslaGateways(storage, connectorId)
	}

	function applyFailedAuth(input: {
		gateway: TeslaGatewayPersistedRecord
		error: unknown
	}) {
		dropSession(connectorId, input.gateway.gatewayId)
		updateTeslaGatewayAuthStatus({
			storage,
			connectorId,
			gatewayId: input.gateway.gatewayId,
			lastAuthenticatedAt: null,
			lastAuthError:
				input.error instanceof Error
					? input.error.message
					: String(input.error),
		})
	}

	return {
		async scan() {
			const result = await scanTeslaGateways(state, config)
			const gateways =
				config.mocksEnabled && result.gateways.length === 0
					? listMockTeslaGatewayDiscoveryEntries()
					: result.gateways
			const discoveryWasFallbackToMocks =
				config.mocksEnabled && result.gateways.length === 0
			upsertDiscoveredTeslaGateways(storage, connectorId, gateways, {
				pruneMissing:
					discoveryWasFallbackToMocks ||
					result.diagnostics.errors.length === 0 ||
					result.gateways.length > 0,
			})
			return listGateways()
		},
		getStatus() {
			const gateways = listGateways()
			return {
				gateways,
				diagnostics: state.teslaGatewayDiscoveryDiagnostics,
				configuredCredentialsCount: gateways.filter(
					(gateway) => gateway.hasStoredCredentials,
				).length,
			}
		},
		listGateways,
		setCredentials(input: {
			gatewayId: string
			password: string
			customerEmailLabel?: string
		}) {
			requireTeslaGateway(storage, connectorId, input.gatewayId)
			const customerEmailLabel = input.customerEmailLabel?.trim()
			saveTeslaGatewayCredentials({
				storage,
				connectorId,
				gatewayId: input.gatewayId,
				password: input.password,
				...(customerEmailLabel ? { customerEmailLabel } : {}),
			})
			dropSession(connectorId, input.gatewayId)
			return toPublicTeslaGateway(
				requireTeslaGateway(storage, connectorId, input.gatewayId),
			)
		},
		setLabel(input: { gatewayId: string; label: string | null }) {
			requireTeslaGateway(storage, connectorId, input.gatewayId)
			setTeslaGatewayLabel({
				storage,
				connectorId,
				gatewayId: input.gatewayId,
				label: input.label,
			})
			return toPublicTeslaGateway(
				requireTeslaGateway(storage, connectorId, input.gatewayId),
			)
		},
		async authenticate(gatewayId: string): Promise<TeslaGatewayPublicRecord> {
			const gateway = requireTeslaGateway(storage, connectorId, gatewayId)
			try {
				dropSession(connectorId, gatewayId)
				await ensureSession({ storage, connectorId, gateway })
				return toPublicTeslaGateway(
					requireTeslaGateway(storage, connectorId, gatewayId),
				)
			} catch (error) {
				applyFailedAuth({ gateway, error })
				throw error
			}
		},
		async getLiveSnapshot(
			gatewayId: string,
		): Promise<TeslaGatewayLiveSnapshot> {
			const gateway = requireTeslaGateway(storage, connectorId, gatewayId)
			try {
				return await fetchLiveFromGateway({ storage, connectorId, gateway })
			} catch (error) {
				applyFailedAuth({ gateway, error })
				throw error
			}
		},
		async findExportLimit(
			gatewayId: string,
		): Promise<TeslaGatewayExportLimitInfo> {
			const gateway = requireTeslaGateway(storage, connectorId, gatewayId)
			const snapshot = await fetchLiveFromGateway({
				storage,
				connectorId,
				gateway,
			})
			return pickExportLimit(snapshot)
		},
		async findAllExportLimits(): Promise<Array<TeslaGatewayExportLimitInfo>> {
			const gateways = listTeslaGateways(storage, connectorId)
			const results: Array<TeslaGatewayExportLimitInfo> = []
			for (const gateway of gateways) {
				try {
					const snapshot = await fetchLiveFromGateway({
						storage,
						connectorId,
						gateway,
					})
					results.push(pickExportLimit(snapshot))
				} catch (error) {
					results.push({
						gatewayId: gateway.gatewayId,
						siteName: gateway.label ?? null,
						exportLimitWatts: null,
						exportLimitKw: null,
						source: 'unknown',
					})
					applyFailedAuth({ gateway, error })
				}
			}
			return results
		},
	}
}

export {
	TeslaGatewayHttpError,
	TeslaGatewayRateLimitError,
} from './gateway-client.ts'
