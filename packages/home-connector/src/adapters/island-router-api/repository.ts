import { decryptSecret, encryptSecret } from '../../storage/encrypted-secret.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'

type IslandRouterApiCredentialRow = {
	connector_id: string
	pin: string
	last_authenticated_at: string | null
	last_auth_error: string | null
}

function mapCredentialRow(
	storage: HomeConnectorStorage,
	row: IslandRouterApiCredentialRow,
) {
	return {
		connectorId: row.connector_id,
		pin: decryptSecret(row.pin, storage.sharedSecret),
		lastAuthenticatedAt: row.last_authenticated_at,
		lastAuthError: row.last_auth_error,
	}
}

export function getIslandRouterApiCredentials(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const row = storage.db
		.query(
			`
				SELECT connector_id, pin, last_authenticated_at, last_auth_error
				FROM island_router_api_credentials
				WHERE connector_id = ?
			`,
		)
		.get(connectorId) as IslandRouterApiCredentialRow | undefined
	return row ? mapCredentialRow(storage, row) : null
}

export function getIslandRouterApiPin(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return getIslandRouterApiCredentials(storage, connectorId)?.pin ?? null
}

export function hasIslandRouterApiStoredPin(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const row = storage.db
		.query(
			`
				SELECT 1 AS found
				FROM island_router_api_credentials
				WHERE connector_id = ?
			`,
		)
		.get(connectorId) as { found: number } | undefined
	return Boolean(row)
}

export function getIslandRouterApiAuthStatus(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const credentials = getIslandRouterApiCredentials(storage, connectorId)
	return credentials
		? {
				lastAuthenticatedAt: credentials.lastAuthenticatedAt,
				lastAuthError: credentials.lastAuthError,
			}
		: null
}

export function saveIslandRouterApiPin(input: {
	storage: HomeConnectorStorage
	connectorId: string
	pin: string
}) {
	const trimmedPin = input.pin.trim()
	if (!trimmedPin) {
		throw new Error('pin must not be empty.')
	}
	const encryptedPin = encryptSecret({
		value: trimmedPin,
		sharedSecret: input.storage.sharedSecret,
		missingSecretMessage:
			'Cannot store Island Router API PIN without HOME_CONNECTOR_SHARED_SECRET.',
	})
	input.storage.db
		.query(
			`
				INSERT INTO island_router_api_credentials (
					connector_id,
					pin,
					last_authenticated_at,
					last_auth_error,
					updated_at
				) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(connector_id) DO UPDATE SET
					pin = excluded.pin,
					last_auth_error = NULL,
					updated_at = excluded.updated_at
			`,
		)
		.run(input.connectorId, encryptedPin, null, null, new Date().toISOString())
}

export function clearIslandRouterApiPin(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	storage.db
		.query(
			`
				DELETE FROM island_router_api_credentials
				WHERE connector_id = ?
			`,
		)
		.run(connectorId)
}

export function updateIslandRouterApiAuthStatus(input: {
	storage: HomeConnectorStorage
	connectorId: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}) {
	input.storage.db
		.query(
			`
				UPDATE island_router_api_credentials
				SET last_authenticated_at = ?,
					last_auth_error = ?,
					updated_at = CURRENT_TIMESTAMP
				WHERE connector_id = ?
			`,
		)
		.run(input.lastAuthenticatedAt, input.lastAuthError, input.connectorId)
}
