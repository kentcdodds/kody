import { type HomeConnectorStorage } from '../../storage/index.ts'

export type VenstarPersistedThermostat = {
	name: string
	ip: string
	lastSeenAt: string | null
}

type VenstarThermostatRow = {
	connector_id: string
	ip: string
	name: string
	last_seen_at: string | null
}

function mapVenstarThermostatRow(
	row: VenstarThermostatRow,
): VenstarPersistedThermostat {
	return {
		name: row.name,
		ip: row.ip,
		lastSeenAt: row.last_seen_at,
	}
}

function selectVenstarThermostatRows(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const statement = storage.db.query(`
		SELECT connector_id, ip, name, last_seen_at
		FROM venstar_thermostats
		WHERE connector_id = ?
		ORDER BY name COLLATE NOCASE, ip
	`)
	return statement.all(connectorId) as Array<VenstarThermostatRow>
}

function getUpsertVenstarThermostatStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO venstar_thermostats (
			connector_id,
			ip,
			name,
			last_seen_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, ip) DO UPDATE SET
			name = excluded.name,
			last_seen_at = excluded.last_seen_at,
			updated_at = excluded.updated_at
	`)
}

function getDeleteVenstarThermostatStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		DELETE FROM venstar_thermostats
		WHERE connector_id = ? AND ip = ?
	`)
}

function getUpdateVenstarLastSeenStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE venstar_thermostats
		SET last_seen_at = ?, updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND ip = ?
	`)
}

export function listVenstarThermostats(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return selectVenstarThermostatRows(storage, connectorId).map(
		mapVenstarThermostatRow,
	)
}

export function getVenstarThermostat(
	storage: HomeConnectorStorage,
	connectorId: string,
	ip: string,
) {
	return (
		listVenstarThermostats(storage, connectorId).find(
			(thermostat) => thermostat.ip === ip,
		) ?? null
	)
}

export function upsertVenstarThermostat(input: {
	storage: HomeConnectorStorage
	connectorId: string
	name: string
	ip: string
	lastSeenAt?: string | null
}) {
	const now = new Date().toISOString()
	getUpsertVenstarThermostatStatement(input.storage).run(
		input.connectorId,
		input.ip,
		input.name,
		input.lastSeenAt ?? null,
		now,
	)
	return getVenstarThermostat(input.storage, input.connectorId, input.ip)
}

export function removeVenstarThermostat(input: {
	storage: HomeConnectorStorage
	connectorId: string
	ip: string
}) {
	getDeleteVenstarThermostatStatement(input.storage).run(
		input.connectorId,
		input.ip,
	)
}

export function updateVenstarLastSeen(input: {
	storage: HomeConnectorStorage
	connectorId: string
	ip: string
	lastSeenAt: string | null
}) {
	getUpdateVenstarLastSeenStatement(input.storage).run(
		input.lastSeenAt,
		input.connectorId,
		input.ip,
	)
}
