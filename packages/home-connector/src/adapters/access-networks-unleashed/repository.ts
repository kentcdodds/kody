import { type HomeConnectorStorage } from '../../storage/index.ts'
import { decryptSecret, encryptSecret } from '../../storage/encrypted-secret.ts'
import {
	type AccessNetworksUnleashedDiscoveredController,
	type AccessNetworksUnleashedPersistedController,
	type AccessNetworksUnleashedPublicController,
} from './types.ts'

type AccessNetworksUnleashedControllerRow = {
	connector_id: string
	controller_id: string
	name: string
	host: string
	login_url: string
	raw_discovery_json: string | null
	adopted: number
	last_seen_at: string | null
	username: string | null
	password: string | null
	last_authenticated_at: string | null
	last_auth_error: string | null
}

function encryptPassword(password: string, sharedSecret: string | null) {
	return encryptSecret({
		value: password,
		sharedSecret,
		missingSecretMessage:
			'Cannot store Access Networks Unleashed credentials without HOME_CONNECTOR_SHARED_SECRET.',
	})
}

function decryptPassword(password: string | null, sharedSecret: string | null) {
	return decryptSecret(password, sharedSecret)
}

function mapControllerRow(
	storage: HomeConnectorStorage,
	row: AccessNetworksUnleashedControllerRow,
): AccessNetworksUnleashedPersistedController {
	return {
		controllerId: row.controller_id,
		name: row.name,
		host: row.host,
		loginUrl: row.login_url,
		lastSeenAt: row.last_seen_at,
		rawDiscovery: row.raw_discovery_json
			? (JSON.parse(row.raw_discovery_json) as Record<string, unknown>)
			: null,
		adopted: Boolean(row.adopted),
		username: row.username,
		password: decryptPassword(row.password, storage.sharedSecret),
		lastAuthenticatedAt: row.last_authenticated_at,
		lastAuthError: row.last_auth_error,
	}
}

function toPublicController(
	controller: AccessNetworksUnleashedPersistedController,
): AccessNetworksUnleashedPublicController {
	const { username, password, lastAuthenticatedAt, lastAuthError, ...rest } =
		controller
	return {
		...rest,
		hasStoredCredentials: Boolean(username && password),
		lastAuthenticatedAt,
		lastAuthError,
	}
}

function selectControllerRows(
	storage: HomeConnectorStorage,
	connectorId: string,
): Array<AccessNetworksUnleashedControllerRow> {
	const statement = storage.db.query(`
		SELECT
			controller.connector_id,
			controller.controller_id,
			controller.name,
			controller.host,
			controller.login_url,
			controller.raw_discovery_json,
			controller.adopted,
			controller.last_seen_at,
			credentials.username,
			credentials.password,
			credentials.last_authenticated_at,
			credentials.last_auth_error
		FROM access_networks_unleashed_controllers AS controller
		LEFT JOIN access_networks_unleashed_credentials AS credentials
			ON credentials.connector_id = controller.connector_id
			AND credentials.controller_id = controller.controller_id
		WHERE controller.connector_id = ?
		ORDER BY controller.name COLLATE NOCASE, controller.controller_id
	`)
	return statement.all(
		connectorId,
	) as Array<AccessNetworksUnleashedControllerRow>
}

function getUpsertControllerStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO access_networks_unleashed_controllers (
			connector_id,
			controller_id,
			name,
			host,
			login_url,
			raw_discovery_json,
			adopted,
			last_seen_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, controller_id) DO UPDATE SET
			name = excluded.name,
			host = excluded.host,
			login_url = excluded.login_url,
			raw_discovery_json = excluded.raw_discovery_json,
			last_seen_at = excluded.last_seen_at,
			updated_at = excluded.updated_at
	`)
}

function getDeleteMissingControllersStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		DELETE FROM access_networks_unleashed_controllers AS controller
		WHERE controller.connector_id = ?
			AND controller.controller_id NOT IN (
				SELECT value
				FROM json_each(?)
			)
			AND controller.adopted = 0
			AND NOT EXISTS (
				SELECT 1
				FROM access_networks_unleashed_credentials AS credentials
				WHERE credentials.connector_id = controller.connector_id
					AND credentials.controller_id = controller.controller_id
			)
	`)
}

function getClearAdoptedControllerStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE access_networks_unleashed_controllers
		SET adopted = 0,
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND adopted = 1
	`)
}

function getMarkControllerAdoptedStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE access_networks_unleashed_controllers
		SET adopted = 1,
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND controller_id = ?
	`)
}

function getDeleteControllerStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		DELETE FROM access_networks_unleashed_controllers
		WHERE connector_id = ? AND controller_id = ?
	`)
}

function getDeleteCredentialsStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		DELETE FROM access_networks_unleashed_credentials
		WHERE connector_id = ? AND controller_id = ?
	`)
}

function getUpsertCredentialsStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO access_networks_unleashed_credentials (
			connector_id,
			controller_id,
			username,
			password,
			last_authenticated_at,
			last_auth_error,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, controller_id) DO UPDATE SET
			username = excluded.username,
			password = excluded.password,
			last_authenticated_at = excluded.last_authenticated_at,
			last_auth_error = excluded.last_auth_error,
			updated_at = excluded.updated_at
	`)
}

function getUpdateAuthStatusStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE access_networks_unleashed_credentials
		SET last_authenticated_at = ?,
			last_auth_error = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND controller_id = ?
	`)
}

export function listAccessNetworksUnleashedControllers(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return selectControllerRows(storage, connectorId).map((row) =>
		mapControllerRow(storage, row),
	)
}

export function listAccessNetworksUnleashedPublicControllers(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return listAccessNetworksUnleashedControllers(storage, connectorId).map(
		toPublicController,
	)
}

export function toAccessNetworksUnleashedPublicController(
	controller: AccessNetworksUnleashedPersistedController,
) {
	return toPublicController(controller)
}

export function getAccessNetworksUnleashedController(
	storage: HomeConnectorStorage,
	connectorId: string,
	controllerId: string,
) {
	return (
		listAccessNetworksUnleashedControllers(storage, connectorId).find(
			(controller) => controller.controllerId === controllerId,
		) ?? null
	)
}

export function getAdoptedAccessNetworksUnleashedController(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return (
		listAccessNetworksUnleashedControllers(storage, connectorId).find(
			(controller) => controller.adopted,
		) ?? null
	)
}

export function upsertDiscoveredAccessNetworksUnleashedControllers(
	storage: HomeConnectorStorage,
	connectorId: string,
	controllers: Array<AccessNetworksUnleashedDiscoveredController>,
) {
	const existing = new Map(
		listAccessNetworksUnleashedControllers(storage, connectorId).map(
			(controller) => [controller.controllerId, controller],
		),
	)
	const now = new Date().toISOString()
	const upsertStatement = getUpsertControllerStatement(storage)
	for (const controller of controllers) {
		upsertStatement.run(
			connectorId,
			controller.controllerId,
			controller.name,
			controller.host,
			controller.loginUrl,
			controller.rawDiscovery ? JSON.stringify(controller.rawDiscovery) : null,
			existing.get(controller.controllerId)?.adopted ? 1 : 0,
			controller.lastSeenAt,
			now,
		)
	}
	const controllerIds = JSON.stringify(
		controllers.map((controller) => controller.controllerId),
	)
	getDeleteMissingControllersStatement(storage).run(connectorId, controllerIds)
	return listAccessNetworksUnleashedControllers(storage, connectorId)
}

export function adoptAccessNetworksUnleashedController(
	storage: HomeConnectorStorage,
	connectorId: string,
	controllerId: string,
) {
	getClearAdoptedControllerStatement(storage).run(connectorId)
	getMarkControllerAdoptedStatement(storage).run(connectorId, controllerId)
	return getAccessNetworksUnleashedController(
		storage,
		connectorId,
		controllerId,
	)
}

export function removeAccessNetworksUnleashedController(input: {
	storage: HomeConnectorStorage
	connectorId: string
	controllerId: string
}) {
	getDeleteCredentialsStatement(input.storage).run(
		input.connectorId,
		input.controllerId,
	)
	getDeleteControllerStatement(input.storage).run(
		input.connectorId,
		input.controllerId,
	)
}

export function saveAccessNetworksUnleashedCredentials(input: {
	storage: HomeConnectorStorage
	connectorId: string
	controllerId: string
	username: string
	password: string
	lastAuthenticatedAt?: string | null
	lastAuthError?: string | null
}) {
	const now = new Date().toISOString()
	getUpsertCredentialsStatement(input.storage).run(
		input.connectorId,
		input.controllerId,
		input.username,
		encryptPassword(input.password, input.storage.sharedSecret),
		input.lastAuthenticatedAt ?? null,
		input.lastAuthError ?? null,
		now,
	)
}

export function updateAccessNetworksUnleashedAuthStatus(input: {
	storage: HomeConnectorStorage
	connectorId: string
	controllerId: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}) {
	getUpdateAuthStatusStatement(input.storage).run(
		input.lastAuthenticatedAt,
		input.lastAuthError,
		input.connectorId,
		input.controllerId,
	)
}
