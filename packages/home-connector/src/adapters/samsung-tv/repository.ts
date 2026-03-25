import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	type SamsungTvDeviceRecord,
	type SamsungTvPersistedDevice,
} from './types.ts'

type SamsungTvRow = {
	connector_id: string
	device_id: string
	host: string
	name: string
	service_url: string | null
	model: string | null
	model_name: string | null
	mac_address: string | null
	frame_tv_support: number
	token_auth_support: number
	power_state: string | null
	raw_device_info_json: string | null
	adopted: number
	last_seen_at: string | null
	token: string | null
	last_verified_at: string | null
	last_auth_error: string | null
}

function mapSamsungTvRow(row: SamsungTvRow): SamsungTvPersistedDevice {
	return {
		deviceId: row.device_id,
		name: row.name,
		host: row.host,
		serviceUrl: row.service_url,
		model: row.model,
		modelName: row.model_name,
		macAddress: row.mac_address,
		frameTvSupport: Boolean(row.frame_tv_support),
		tokenAuthSupport: Boolean(row.token_auth_support),
		powerState: row.power_state,
		lastSeenAt: row.last_seen_at,
		adopted: Boolean(row.adopted),
		rawDeviceInfo: row.raw_device_info_json
			? (JSON.parse(row.raw_device_info_json) as Record<string, unknown>)
			: null,
		token: row.token,
		lastVerifiedAt: row.last_verified_at,
		lastAuthError: row.last_auth_error,
	}
}

function selectSamsungTvRows(
	storage: HomeConnectorStorage,
	connectorId: string,
): Array<SamsungTvRow> {
	const statement = storage.db.query(`
		SELECT
			tv.connector_id,
			tv.device_id,
			tv.host,
			tv.name,
			tv.service_url,
			tv.model,
			tv.model_name,
			tv.mac_address,
			tv.frame_tv_support,
			tv.token_auth_support,
			tv.power_state,
			tv.raw_device_info_json,
			tv.adopted,
			tv.last_seen_at,
			token.token,
			token.last_verified_at,
			token.last_auth_error
		FROM samsung_tvs AS tv
		LEFT JOIN samsung_tokens AS token
			ON token.connector_id = tv.connector_id
			AND token.device_id = tv.device_id
		WHERE tv.connector_id = ?
		ORDER BY tv.name COLLATE NOCASE, tv.device_id
	`)
	return statement.all(connectorId) as Array<SamsungTvRow>
}

function getUpsertSamsungTvStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO samsung_tvs (
			connector_id,
			device_id,
			host,
			name,
			service_url,
			model,
			model_name,
			mac_address,
			frame_tv_support,
			token_auth_support,
			power_state,
			raw_device_info_json,
			adopted,
			last_seen_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, device_id) DO UPDATE SET
			host = excluded.host,
			name = excluded.name,
			service_url = excluded.service_url,
			model = excluded.model,
			model_name = excluded.model_name,
			mac_address = excluded.mac_address,
			frame_tv_support = excluded.frame_tv_support,
			token_auth_support = excluded.token_auth_support,
			power_state = excluded.power_state,
			raw_device_info_json = excluded.raw_device_info_json,
			last_seen_at = excluded.last_seen_at,
			updated_at = excluded.updated_at
	`)
}

function getUpdateSamsungAdoptedStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE samsung_tvs
		SET adopted = ?, updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND device_id = ?
	`)
}

function getUpsertSamsungTokenStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO samsung_tokens (
			connector_id,
			device_id,
			token,
			last_verified_at,
			last_auth_error,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, device_id) DO UPDATE SET
			token = excluded.token,
			last_verified_at = excluded.last_verified_at,
			last_auth_error = excluded.last_auth_error,
			updated_at = excluded.updated_at
	`)
}

function getUpdateSamsungTokenErrorStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE samsung_tokens
		SET last_auth_error = ?, last_verified_at = ?, updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND device_id = ?
	`)
}

function getDeleteMissingSamsungTvsStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		DELETE FROM samsung_tvs
		WHERE connector_id = ?
			AND device_id NOT IN (
				SELECT value
				FROM json_each(?)
			)
			AND adopted = 0
	`)
}

function getUpdateSamsungPowerStateStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE samsung_tvs
		SET power_state = ?, updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND device_id = ?
	`)
}

export function listSamsungTvDevices(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return selectSamsungTvRows(storage, connectorId).map(mapSamsungTvRow)
}

export function getSamsungTvDevice(
	storage: HomeConnectorStorage,
	connectorId: string,
	deviceId: string,
) {
	return (
		listSamsungTvDevices(storage, connectorId).find(
			(device) => device.deviceId === deviceId,
		) ?? null
	)
}

export function upsertDiscoveredSamsungTvs(
	storage: HomeConnectorStorage,
	connectorId: string,
	devices: Array<SamsungTvDeviceRecord>,
) {
	const existing = new Map(
		listSamsungTvDevices(storage, connectorId).map((device) => [
			device.deviceId,
			device,
		]),
	)
	const now = new Date().toISOString()
	const upsertStatement = getUpsertSamsungTvStatement(storage)
	for (const device of devices) {
		const current = existing.get(device.deviceId)
		upsertStatement.run(
			connectorId,
			device.deviceId,
			device.host,
			device.name,
			device.serviceUrl,
			device.model,
			device.modelName,
			device.macAddress,
			device.frameTvSupport ? 1 : 0,
			device.tokenAuthSupport ? 1 : 0,
			device.powerState,
			device.rawDeviceInfo ? JSON.stringify(device.rawDeviceInfo) : null,
			current?.adopted ? 1 : device.adopted ? 1 : 0,
			device.lastSeenAt,
			now,
		)
	}
	const discoveredIds = JSON.stringify(devices.map((device) => device.deviceId))
	getDeleteMissingSamsungTvsStatement(storage).run(connectorId, discoveredIds)
	return listSamsungTvDevices(storage, connectorId)
}

export function adoptSamsungTvDevice(
	storage: HomeConnectorStorage,
	connectorId: string,
	deviceId: string,
) {
	getUpdateSamsungAdoptedStatement(storage).run(1, connectorId, deviceId)
	return getSamsungTvDevice(storage, connectorId, deviceId)
}

export function ignoreSamsungTvDevice(
	storage: HomeConnectorStorage,
	connectorId: string,
	deviceId: string,
) {
	getUpdateSamsungAdoptedStatement(storage).run(0, connectorId, deviceId)
	return getSamsungTvDevice(storage, connectorId, deviceId)
}

export function saveSamsungTvToken(input: {
	storage: HomeConnectorStorage
	connectorId: string
	deviceId: string
	token: string
	lastVerifiedAt?: string | null
	lastAuthError?: string | null
}) {
	const now = new Date().toISOString()
	getUpsertSamsungTokenStatement(input.storage).run(
		input.connectorId,
		input.deviceId,
		input.token,
		input.lastVerifiedAt ?? now,
		input.lastAuthError ?? null,
		now,
	)
}

export function updateSamsungTvPowerState(input: {
	storage: HomeConnectorStorage
	connectorId: string
	deviceId: string
	powerState: string | null
}) {
	getUpdateSamsungPowerStateStatement(input.storage).run(
		input.powerState,
		input.connectorId,
		input.deviceId,
	)
}

export function updateSamsungTvTokenError(input: {
	storage: HomeConnectorStorage
	connectorId: string
	deviceId: string
	lastAuthError: string | null
	lastVerifiedAt?: string | null
}) {
	getUpdateSamsungTokenErrorStatement(input.storage).run(
		input.lastAuthError,
		input.lastVerifiedAt ?? null,
		input.connectorId,
		input.deviceId,
	)
}

export function requireSamsungTvDevice(
	storage: HomeConnectorStorage,
	connectorId: string,
	deviceId: string,
) {
	const device = getSamsungTvDevice(storage, connectorId, deviceId)
	if (!device) {
		throw new Error(`Samsung TV device "${deviceId}" was not found.`)
	}
	return device
}
