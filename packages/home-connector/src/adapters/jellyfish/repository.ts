import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	type JellyfishDiscoveredController,
	type JellyfishPersistedController,
} from './types.ts'

type JellyfishControllerRow = {
	connector_id: string
	controller_id: string
	name: string
	hostname: string
	host: string
	port: number
	firmware_version: string | null
	last_seen_at: string | null
	last_connected_at: string | null
	last_error: string | null
}

function mapJellyfishControllerRow(
	row: JellyfishControllerRow,
): JellyfishPersistedController {
	return {
		controllerId: row.controller_id,
		name: row.name,
		hostname: row.hostname,
		host: row.host,
		port: row.port,
		firmwareVersion: row.firmware_version,
		lastSeenAt: row.last_seen_at,
		lastConnectedAt: row.last_connected_at,
		lastError: row.last_error,
	}
}

function getListControllersStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		SELECT
			connector_id,
			controller_id,
			name,
			hostname,
			host,
			port,
			firmware_version,
			last_seen_at,
			last_connected_at,
			last_error
		FROM jellyfish_controllers
		WHERE connector_id = ?
		ORDER BY name COLLATE NOCASE, controller_id
	`)
}

function getUpsertControllerStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO jellyfish_controllers (
			connector_id,
			controller_id,
			name,
			hostname,
			host,
			port,
			firmware_version,
			last_seen_at,
			last_connected_at,
			last_error,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, controller_id) DO UPDATE SET
			name = excluded.name,
			hostname = excluded.hostname,
			host = excluded.host,
			port = excluded.port,
			firmware_version = excluded.firmware_version,
			last_seen_at = excluded.last_seen_at,
			updated_at = excluded.updated_at
	`)
}

function getUpdateControllerConnectionStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE jellyfish_controllers
		SET
			host = ?,
			port = ?,
			last_connected_at = ?,
			last_error = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND controller_id = ?
	`)
}

function getControllerByIdStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		SELECT
			connector_id,
			controller_id,
			name,
			hostname,
			host,
			port,
			firmware_version,
			last_seen_at,
			last_connected_at,
			last_error
		FROM jellyfish_controllers
		WHERE connector_id = ? AND controller_id = ?
	`)
}

export function listJellyfishControllers(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return (
		getListControllersStatement(storage).all(
			connectorId,
		) as Array<JellyfishControllerRow>
	).map(mapJellyfishControllerRow)
}

export function getJellyfishController(
	storage: HomeConnectorStorage,
	connectorId: string,
	controllerId: string,
) {
	const row = getControllerByIdStatement(storage).get(
		connectorId,
		controllerId,
	) as JellyfishControllerRow | undefined
	return row ? mapJellyfishControllerRow(row) : null
}

export function upsertDiscoveredJellyfishControllers(input: {
	storage: HomeConnectorStorage
	connectorId: string
	controllers: Array<JellyfishDiscoveredController>
}) {
	const now = new Date().toISOString()
	const existing = new Map(
		listJellyfishControllers(input.storage, input.connectorId).map(
			(controller) => [controller.controllerId, controller],
		),
	)
	const statement = getUpsertControllerStatement(input.storage)
	for (const controller of input.controllers) {
		const current = existing.get(controller.controllerId)
		statement.run(
			input.connectorId,
			controller.controllerId,
			controller.name,
			controller.hostname,
			controller.host,
			controller.port,
			controller.firmwareVersion,
			controller.lastSeenAt,
			current?.lastConnectedAt ?? null,
			current?.lastError ?? null,
			now,
		)
	}
	return listJellyfishControllers(input.storage, input.connectorId)
}

export function updateJellyfishControllerConnection(input: {
	storage: HomeConnectorStorage
	connectorId: string
	controllerId: string
	host: string
	port: number
	lastConnectedAt: string | null
	lastError: string | null
}) {
	getUpdateControllerConnectionStatement(input.storage).run(
		input.host,
		input.port,
		input.lastConnectedAt,
		input.lastError,
		input.connectorId,
		input.controllerId,
	)
	return getJellyfishController(
		input.storage,
		input.connectorId,
		input.controllerId,
	)
}
