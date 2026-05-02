/**
 * SQLite persistence for discovered/configured Tesla gateways and their
 * cached customer credentials. Mirrors the lutron repository pattern: device
 * rows are upserted on every discovery scan; credentials live in a sibling
 * table protected by AES-256-GCM keyed off `HOME_CONNECTOR_SHARED_SECRET`.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	type TeslaGatewayDiscoveredGateway,
	type TeslaGatewayPersistedRecord,
	type TeslaGatewayPublicRecord,
} from './types.ts'

type TeslaGatewayRow = {
	connector_id: string
	gateway_id: string
	host: string
	port: number
	din: string | null
	serial_number: string | null
	mac_address: string | null
	mac_oui: string | null
	cert_subject_cn: string | null
	cert_subject_o: string | null
	cert_subject_ou: string | null
	cert_issuer_cn: string | null
	cert_issuer_o: string | null
	cert_san: string | null
	cert_fingerprint_sha256: string | null
	firmware_version: string | null
	role: string | null
	last_seen_at: string | null
	label: string | null
	customer_email_label: string | null
	password: string | null
	last_authenticated_at: string | null
	last_auth_error: string | null
}

const PASSWORD_PREFIX = 'enc:v1:'
const PASSWORD_AUTH_TAG_BYTES = 16
const DEFAULT_EMAIL_LABEL = 'kody@local'

function getPasswordKey(sharedSecret: string) {
	return createHash('sha256').update(sharedSecret).digest()
}

function encryptPassword(password: string, sharedSecret: string | null) {
	if (!sharedSecret) {
		throw new Error(
			'Cannot store Tesla gateway credentials without HOME_CONNECTOR_SHARED_SECRET.',
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
	if (!sharedSecret) return null
	const payload = password.slice(PASSWORD_PREFIX.length)
	const [ivBase64, tagBase64, encryptedBase64] = payload.split(':')
	if (!ivBase64 || !tagBase64 || !encryptedBase64) return null
	try {
		const key = getPasswordKey(sharedSecret)
		const iv = Buffer.from(ivBase64, 'base64')
		const tag = Buffer.from(tagBase64, 'base64')
		const encrypted = Buffer.from(encryptedBase64, 'base64')
		if (iv.length !== 12 || tag.length !== PASSWORD_AUTH_TAG_BYTES) return null
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

function mapRow(
	storage: HomeConnectorStorage,
	row: TeslaGatewayRow,
): TeslaGatewayPersistedRecord {
	return {
		gatewayId: row.gateway_id,
		host: row.host,
		port: row.port,
		din: row.din,
		serialNumber: row.serial_number,
		macAddress: row.mac_address,
		macOui: row.mac_oui,
		cert:
			row.cert_subject_cn || row.cert_subject_o
				? {
						subjectCommonName: row.cert_subject_cn,
						subjectOrganization: row.cert_subject_o,
						subjectOrganizationalUnit: row.cert_subject_ou,
						issuerCommonName: row.cert_issuer_cn,
						issuerOrganization: row.cert_issuer_o,
						subjectAltName: row.cert_san,
						fingerprint256: row.cert_fingerprint_sha256,
					}
				: null,
		firmwareVersion: row.firmware_version,
		role:
			row.role === 'leader' || row.role === 'follower' ? row.role : 'unknown',
		lastSeenAt: row.last_seen_at ?? new Date(0).toISOString(),
		label: row.label,
		customerEmailLabel: row.customer_email_label ?? DEFAULT_EMAIL_LABEL,
		password: decryptPassword(row.password, storage.sharedSecret),
		lastAuthenticatedAt: row.last_authenticated_at,
		lastAuthError: row.last_auth_error,
	}
}

export function toPublicTeslaGateway(
	gateway: TeslaGatewayPersistedRecord,
): TeslaGatewayPublicRecord {
	const { customerEmailLabel, password, ...rest } = gateway
	return {
		...rest,
		hasStoredCredentials: password !== null && password !== '',
		hasCustomCustomerEmailLabel: customerEmailLabel !== DEFAULT_EMAIL_LABEL,
	}
}

function selectRows(storage: HomeConnectorStorage, connectorId: string) {
	const statement = storage.db.query(`
		SELECT
			gateway.connector_id,
			gateway.gateway_id,
			gateway.host,
			gateway.port,
			gateway.din,
			gateway.serial_number,
			gateway.mac_address,
			gateway.mac_oui,
			gateway.cert_subject_cn,
			gateway.cert_subject_o,
			gateway.cert_subject_ou,
			gateway.cert_issuer_cn,
			gateway.cert_issuer_o,
			gateway.cert_san,
			gateway.cert_fingerprint_sha256,
			gateway.firmware_version,
			gateway.role,
			gateway.last_seen_at,
			gateway.label,
			credentials.customer_email_label,
			credentials.password,
			credentials.last_authenticated_at,
			credentials.last_auth_error
		FROM tesla_gateways AS gateway
		LEFT JOIN tesla_gateway_credentials AS credentials
			ON credentials.connector_id = gateway.connector_id
			AND credentials.gateway_id = gateway.gateway_id
		WHERE gateway.connector_id = ?
		ORDER BY gateway.label COLLATE NOCASE, gateway.gateway_id
	`)
	return statement.all(connectorId) as Array<TeslaGatewayRow>
}

function getUpsertGatewayStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO tesla_gateways (
			connector_id,
			gateway_id,
			host,
			port,
			din,
			serial_number,
			mac_address,
			mac_oui,
			cert_subject_cn,
			cert_subject_o,
			cert_subject_ou,
			cert_issuer_cn,
			cert_issuer_o,
			cert_san,
			cert_fingerprint_sha256,
			firmware_version,
			role,
			last_seen_at,
			label,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, gateway_id) DO UPDATE SET
			host = excluded.host,
			port = excluded.port,
			din = COALESCE(excluded.din, tesla_gateways.din),
			serial_number = COALESCE(excluded.serial_number, tesla_gateways.serial_number),
			mac_address = COALESCE(excluded.mac_address, tesla_gateways.mac_address),
			mac_oui = COALESCE(excluded.mac_oui, tesla_gateways.mac_oui),
			cert_subject_cn = excluded.cert_subject_cn,
			cert_subject_o = excluded.cert_subject_o,
			cert_subject_ou = excluded.cert_subject_ou,
			cert_issuer_cn = excluded.cert_issuer_cn,
			cert_issuer_o = excluded.cert_issuer_o,
			cert_san = excluded.cert_san,
			cert_fingerprint_sha256 = excluded.cert_fingerprint_sha256,
			firmware_version = COALESCE(excluded.firmware_version, tesla_gateways.firmware_version),
			role = excluded.role,
			last_seen_at = excluded.last_seen_at,
			updated_at = excluded.updated_at
	`)
}

function getDeleteMissingGatewaysStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		DELETE FROM tesla_gateways AS gateway
		WHERE gateway.connector_id = ?
			AND gateway.gateway_id NOT IN (
				SELECT value FROM json_each(?)
			)
			AND NOT EXISTS (
				SELECT 1 FROM tesla_gateway_credentials AS credentials
				WHERE credentials.connector_id = gateway.connector_id
					AND credentials.gateway_id = gateway.gateway_id
			)
	`)
}

function getUpsertCredentialsStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO tesla_gateway_credentials (
			connector_id,
			gateway_id,
			customer_email_label,
			password,
			last_authenticated_at,
			last_auth_error,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, gateway_id) DO UPDATE SET
			customer_email_label = excluded.customer_email_label,
			password = excluded.password,
			last_authenticated_at = excluded.last_authenticated_at,
			last_auth_error = excluded.last_auth_error,
			updated_at = excluded.updated_at
	`)
}

function getUpdateAuthStatusStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE tesla_gateway_credentials
		SET last_authenticated_at = ?,
			last_auth_error = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND gateway_id = ?
	`)
}

function getUpdateLabelStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE tesla_gateways
		SET label = ?, updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND gateway_id = ?
	`)
}

function getUpdateGatewayMetadataStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE tesla_gateways
		SET din = COALESCE(?, din),
			serial_number = COALESCE(?, serial_number),
			firmware_version = COALESCE(?, firmware_version),
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND gateway_id = ?
	`)
}

export function listTeslaGateways(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return selectRows(storage, connectorId).map((row) => mapRow(storage, row))
}

export function listPublicTeslaGateways(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return listTeslaGateways(storage, connectorId).map(toPublicTeslaGateway)
}

export function getTeslaGateway(
	storage: HomeConnectorStorage,
	connectorId: string,
	gatewayId: string,
) {
	return (
		listTeslaGateways(storage, connectorId).find(
			(gateway) => gateway.gatewayId === gatewayId,
		) ?? null
	)
}

export function requireTeslaGateway(
	storage: HomeConnectorStorage,
	connectorId: string,
	gatewayId: string,
) {
	const gateway = getTeslaGateway(storage, connectorId, gatewayId)
	if (!gateway) {
		throw new Error(`Tesla gateway "${gatewayId}" was not found.`)
	}
	return gateway
}

export function upsertDiscoveredTeslaGateways(
	storage: HomeConnectorStorage,
	connectorId: string,
	gateways: Array<TeslaGatewayDiscoveredGateway>,
	options: { pruneMissing?: boolean } = {},
) {
	const now = new Date().toISOString()
	const upsert = getUpsertGatewayStatement(storage)
	for (const gateway of gateways) {
		upsert.run(
			connectorId,
			gateway.gatewayId,
			gateway.host,
			gateway.port,
			gateway.din,
			gateway.serialNumber,
			gateway.macAddress,
			gateway.macOui,
			gateway.cert?.subjectCommonName ?? null,
			gateway.cert?.subjectOrganization ?? null,
			gateway.cert?.subjectOrganizationalUnit ?? null,
			gateway.cert?.issuerCommonName ?? null,
			gateway.cert?.issuerOrganization ?? null,
			gateway.cert?.subjectAltName ?? null,
			gateway.cert?.fingerprint256 ?? null,
			gateway.firmwareVersion,
			gateway.role,
			gateway.lastSeenAt,
			null,
			now,
		)
	}
	if (options.pruneMissing ?? true) {
		const ids = JSON.stringify(gateways.map((gateway) => gateway.gatewayId))
		getDeleteMissingGatewaysStatement(storage).run(connectorId, ids)
	}
	return listTeslaGateways(storage, connectorId)
}

export function saveTeslaGatewayCredentials(input: {
	storage: HomeConnectorStorage
	connectorId: string
	gatewayId: string
	customerEmailLabel?: string
	password: string
}) {
	const now = new Date().toISOString()
	getUpsertCredentialsStatement(input.storage).run(
		input.connectorId,
		input.gatewayId,
		input.customerEmailLabel ?? DEFAULT_EMAIL_LABEL,
		encryptPassword(input.password, input.storage.sharedSecret),
		null,
		null,
		now,
	)
}

export function updateTeslaGatewayAuthStatus(input: {
	storage: HomeConnectorStorage
	connectorId: string
	gatewayId: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}) {
	getUpdateAuthStatusStatement(input.storage).run(
		input.lastAuthenticatedAt,
		input.lastAuthError,
		input.connectorId,
		input.gatewayId,
	)
}

export function setTeslaGatewayLabel(input: {
	storage: HomeConnectorStorage
	connectorId: string
	gatewayId: string
	label: string | null
}) {
	getUpdateLabelStatement(input.storage).run(
		input.label,
		input.connectorId,
		input.gatewayId,
	)
}

export function updateTeslaGatewayMetadata(input: {
	storage: HomeConnectorStorage
	connectorId: string
	gatewayId: string
	din?: string | null
	serialNumber?: string | null
	firmwareVersion?: string | null
}) {
	getUpdateGatewayMetadataStatement(input.storage).run(
		input.din ?? null,
		input.serialNumber ?? null,
		input.firmwareVersion ?? null,
		input.connectorId,
		input.gatewayId,
	)
}
