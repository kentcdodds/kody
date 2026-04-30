import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	type LutronDiscoveredProcessor,
	type LutronPublicProcessor,
	type LutronPersistedProcessor,
} from './types.ts'
import { LutronProcessorNotFoundError } from './errors.ts'

type LutronProcessorRow = {
	connector_id: string
	processor_id: string
	instance_name: string
	name: string
	host: string
	port: number
	discovery_port: number | null
	address: string | null
	serial_number: string | null
	mac_address: string | null
	system_type: string | null
	code_version: string | null
	device_class: string | null
	claim_status: string | null
	network_status: string | null
	firmware_status: string | null
	status: string | null
	raw_discovery_json: string | null
	last_seen_at: string | null
	username: string | null
	password: string | null
	last_authenticated_at: string | null
	last_auth_error: string | null
}

const PASSWORD_PREFIX = 'enc:v1:'
const PASSWORD_AUTH_TAG_BYTES = 16

function getPasswordKey(sharedSecret: string) {
	return createHash('sha256').update(sharedSecret).digest()
}

function encryptPassword(password: string, sharedSecret: string | null) {
	if (!sharedSecret) {
		throw new Error(
			'Cannot store Lutron credentials without HOME_CONNECTOR_SHARED_SECRET.',
		)
	}
	const iv = randomBytes(12)
	const key = getPasswordKey(sharedSecret)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const encrypted = Buffer.concat([
		cipher.update(password, 'utf8'),
		cipher.final(),
	])
	const tag = cipher.getAuthTag()
	return `${PASSWORD_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

function decryptPassword(password: string | null, sharedSecret: string | null) {
	if (!password || !password.startsWith(PASSWORD_PREFIX)) {
		return password
	}
	if (!sharedSecret) {
		return null
	}
	const payload = password.slice(PASSWORD_PREFIX.length)
	const [ivBase64, tagBase64, encryptedBase64] = payload.split(':')
	if (!ivBase64 || !tagBase64 || !encryptedBase64) {
		return null
	}
	try {
		const key = getPasswordKey(sharedSecret)
		const iv = Buffer.from(ivBase64, 'base64')
		const tag = Buffer.from(tagBase64, 'base64')
		const encrypted = Buffer.from(encryptedBase64, 'base64')
		if (iv.length !== 12 || tag.length !== PASSWORD_AUTH_TAG_BYTES) {
			return null
		}
		const decipher = createDecipheriv('aes-256-gcm', key, iv)
		decipher.setAuthTag(tag)
		const decrypted = Buffer.concat([
			decipher.update(encrypted),
			decipher.final(),
		])
		return decrypted.toString('utf8')
	} catch {
		return null
	}
}

function mapLutronProcessorRow(
	storage: HomeConnectorStorage,
	row: LutronProcessorRow,
): LutronPersistedProcessor {
	return {
		processorId: row.processor_id,
		instanceName: row.instance_name,
		name: row.name,
		host: row.host,
		discoveryPort: row.discovery_port,
		leapPort: row.port,
		address: row.address,
		serialNumber: row.serial_number,
		macAddress: row.mac_address,
		systemType: row.system_type,
		codeVersion: row.code_version,
		deviceClass: row.device_class,
		claimStatus: row.claim_status,
		networkStatus: row.network_status,
		firmwareStatus: row.firmware_status,
		status: row.status,
		lastSeenAt: row.last_seen_at,
		rawDiscovery: row.raw_discovery_json
			? (JSON.parse(row.raw_discovery_json) as Record<string, unknown>)
			: null,
		username: row.username,
		password: decryptPassword(row.password, storage.sharedSecret),
		lastAuthenticatedAt: row.last_authenticated_at,
		lastAuthError: row.last_auth_error,
	}
}

function toPublicLutronProcessor(
	processor: LutronPersistedProcessor,
): LutronPublicProcessor {
	const {
		username,
		password: _password,
		lastAuthenticatedAt,
		lastAuthError,
		...rest
	} = processor
	return {
		...rest,
		hasStoredCredentials: Boolean(username),
		lastAuthenticatedAt,
		lastAuthError,
	}
}

function selectLutronProcessorRows(
	storage: HomeConnectorStorage,
	connectorId: string,
): Array<LutronProcessorRow> {
	const statement = storage.db.query(`
		SELECT
			processor.connector_id,
			processor.processor_id,
			processor.instance_name,
			processor.name,
			processor.host,
			processor.port,
			processor.discovery_port,
			processor.address,
			processor.serial_number,
			processor.mac_address,
			processor.system_type,
			processor.code_version,
			processor.device_class,
			processor.claim_status,
			processor.network_status,
			processor.firmware_status,
			processor.status,
			processor.raw_discovery_json,
			processor.last_seen_at,
			credentials.username,
			credentials.password,
			credentials.last_authenticated_at,
			credentials.last_auth_error
		FROM lutron_processors AS processor
		LEFT JOIN lutron_credentials AS credentials
			ON credentials.connector_id = processor.connector_id
			AND credentials.processor_id = processor.processor_id
		WHERE processor.connector_id = ?
		ORDER BY processor.name COLLATE NOCASE, processor.processor_id
	`)

	return statement.all(connectorId) as Array<LutronProcessorRow>
}

function getUpsertLutronProcessorStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO lutron_processors (
			connector_id,
			processor_id,
			instance_name,
			name,
			host,
			port,
			discovery_port,
			address,
			serial_number,
			mac_address,
			system_type,
			code_version,
			device_class,
			claim_status,
			network_status,
			firmware_status,
			status,
			raw_discovery_json,
			last_seen_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, processor_id) DO UPDATE SET
			instance_name = excluded.instance_name,
			name = excluded.name,
			host = excluded.host,
			port = excluded.port,
			discovery_port = excluded.discovery_port,
			address = excluded.address,
			serial_number = excluded.serial_number,
			mac_address = excluded.mac_address,
			system_type = excluded.system_type,
			code_version = excluded.code_version,
			device_class = excluded.device_class,
			claim_status = excluded.claim_status,
			network_status = excluded.network_status,
			firmware_status = excluded.firmware_status,
			status = excluded.status,
			raw_discovery_json = excluded.raw_discovery_json,
			last_seen_at = excluded.last_seen_at,
			updated_at = excluded.updated_at
	`)
}

function getDeleteMissingLutronProcessorsStatement(
	storage: HomeConnectorStorage,
) {
	return storage.db.query(`
		DELETE FROM lutron_processors AS processor
		WHERE processor.connector_id = ?
			AND processor.processor_id NOT IN (
				SELECT value
				FROM json_each(?)
			)
			AND NOT EXISTS (
				SELECT 1
				FROM lutron_credentials AS credentials
				WHERE credentials.connector_id = processor.connector_id
					AND credentials.processor_id = processor.processor_id
			)
	`)
}

function getUpsertLutronCredentialsStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO lutron_credentials (
			connector_id,
			processor_id,
			username,
			password,
			last_authenticated_at,
			last_auth_error,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, processor_id) DO UPDATE SET
			username = excluded.username,
			password = excluded.password,
			last_authenticated_at = excluded.last_authenticated_at,
			last_auth_error = excluded.last_auth_error,
			updated_at = excluded.updated_at
	`)
}

function getUpdateLutronAuthStatusStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE lutron_credentials
		SET last_authenticated_at = ?,
			last_auth_error = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND processor_id = ?
	`)
}

export function listLutronProcessors(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return selectLutronProcessorRows(storage, connectorId).map((row) =>
		mapLutronProcessorRow(storage, row),
	)
}

export function listLutronPublicProcessors(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return listLutronProcessors(storage, connectorId).map(toPublicLutronProcessor)
}

export function toLutronPublicProcessor(
	processor: LutronPersistedProcessor,
): LutronPublicProcessor {
	return toPublicLutronProcessor(processor)
}

export function getLutronProcessor(
	storage: HomeConnectorStorage,
	connectorId: string,
	processorId: string,
) {
	return (
		listLutronProcessors(storage, connectorId).find(
			(processor) => processor.processorId === processorId,
		) ?? null
	)
}

export function upsertDiscoveredLutronProcessors(
	storage: HomeConnectorStorage,
	connectorId: string,
	processors: Array<LutronDiscoveredProcessor>,
) {
	const now = new Date().toISOString()
	const upsertStatement = getUpsertLutronProcessorStatement(storage)

	for (const processor of processors) {
		upsertStatement.run(
			connectorId,
			processor.processorId,
			processor.instanceName,
			processor.name,
			processor.host,
			processor.leapPort,
			processor.discoveryPort,
			processor.address,
			processor.serialNumber,
			processor.macAddress,
			processor.systemType,
			processor.codeVersion,
			processor.deviceClass,
			processor.claimStatus,
			processor.networkStatus,
			processor.firmwareStatus,
			processor.status,
			processor.rawDiscovery ? JSON.stringify(processor.rawDiscovery) : null,
			processor.lastSeenAt,
			now,
		)
	}

	const processorIds = JSON.stringify(
		processors.map((processor) => processor.processorId),
	)
	getDeleteMissingLutronProcessorsStatement(storage).run(
		connectorId,
		processorIds,
	)

	return listLutronProcessors(storage, connectorId)
}

export function saveLutronCredentials(input: {
	storage: HomeConnectorStorage
	connectorId: string
	processorId: string
	username: string
	password: string
	lastAuthenticatedAt?: string | null
	lastAuthError?: string | null
}) {
	const now = new Date().toISOString()
	getUpsertLutronCredentialsStatement(input.storage).run(
		input.connectorId,
		input.processorId,
		input.username,
		encryptPassword(input.password, input.storage.sharedSecret),
		input.lastAuthenticatedAt ?? null,
		input.lastAuthError ?? null,
		now,
	)
}

export function updateLutronAuthStatus(input: {
	storage: HomeConnectorStorage
	connectorId: string
	processorId: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}) {
	getUpdateLutronAuthStatusStatement(input.storage).run(
		input.lastAuthenticatedAt,
		input.lastAuthError,
		input.connectorId,
		input.processorId,
	)
}

export function requireLutronProcessor(
	storage: HomeConnectorStorage,
	connectorId: string,
	processorId: string,
) {
	const processor = getLutronProcessor(storage, connectorId, processorId)
	if (!processor) {
		throw new LutronProcessorNotFoundError(processorId)
	}
	return processor
}
