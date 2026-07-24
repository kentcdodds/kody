import {
	parseStoredWebhookVerificationConfig,
	serializeStoredWebhookVerificationConfig,
} from './verification.ts'
import {
	type StoredWebhookVerificationConfig,
	type WebhookDeliveryOutcome,
	type WebhookDeliveryRecord,
	type WebhookEndpointRecord,
	type WebhookResponseMode,
	webhookDeliveriesRetainedPerEndpoint,
	webhookDeliveryErrorMaxLength,
} from './types.ts'

type WebhookEndpointRow = {
	id: string
	user_id: string
	name: string
	package_id: string
	export_name: string
	url_secret_hash: string
	verification_config: string | null
	response_mode: WebhookResponseMode
	enabled: number
	created_at: string
	updated_at: string
}

type WebhookDeliveryRow = {
	id: string
	endpoint_id: string
	user_id: string
	received_at: string
	outcome: WebhookDeliveryOutcome
	http_status: number
	error: string | null
	payload_bytes: number
}

function mapEndpointRow(row: WebhookEndpointRow): WebhookEndpointRecord {
	return {
		id: row.id,
		userId: row.user_id,
		name: row.name,
		packageId: row.package_id,
		exportName: row.export_name,
		urlSecretHash: row.url_secret_hash,
		verificationConfig: parseStoredWebhookVerificationConfig(
			row.verification_config,
		),
		responseMode: row.response_mode,
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function mapDeliveryRow(row: WebhookDeliveryRow): WebhookDeliveryRecord {
	return {
		id: row.id,
		endpointId: row.endpoint_id,
		userId: row.user_id,
		receivedAt: row.received_at,
		outcome: row.outcome,
		httpStatus: row.http_status,
		error: row.error,
		payloadBytes: row.payload_bytes,
	}
}

function truncateDeliveryError(error: string | null | undefined) {
	if (!error) return null
	const trimmed = error.trim()
	if (!trimmed) return null
	if (trimmed.length <= webhookDeliveryErrorMaxLength) return trimmed
	return `${trimmed.slice(0, webhookDeliveryErrorMaxLength - 1)}…`
}

export async function insertWebhookEndpoint(input: {
	db: D1Database
	id: string
	userId: string
	name: string
	packageId: string
	exportName: string
	urlSecretHash: string
	verificationConfig: StoredWebhookVerificationConfig | null
	responseMode: WebhookResponseMode
	enabled?: boolean
	now?: string
}): Promise<WebhookEndpointRecord> {
	const now = input.now ?? new Date().toISOString()
	const enabled = input.enabled === false ? 0 : 1
	const verificationConfigJson = input.verificationConfig
		? serializeStoredWebhookVerificationConfig(input.verificationConfig)
		: null
	await input.db
		.prepare(
			`INSERT INTO webhook_endpoints (
				id, user_id, name, package_id, export_name, url_secret_hash,
				verification_config, response_mode, enabled, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.userId,
			input.name,
			input.packageId,
			input.exportName,
			input.urlSecretHash,
			verificationConfigJson,
			input.responseMode,
			enabled,
			now,
			now,
		)
		.run()
	return {
		id: input.id,
		userId: input.userId,
		name: input.name,
		packageId: input.packageId,
		exportName: input.exportName,
		urlSecretHash: input.urlSecretHash,
		verificationConfig: input.verificationConfig,
		responseMode: input.responseMode,
		enabled: enabled === 1,
		createdAt: now,
		updatedAt: now,
	}
}

export async function listWebhookEndpointsForUser(input: {
	db: D1Database
	userId: string
}): Promise<Array<WebhookEndpointRecord>> {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM webhook_endpoints
			WHERE user_id = ?
			ORDER BY created_at DESC, id DESC`,
		)
		.bind(input.userId)
		.all<WebhookEndpointRow>()
	return (result.results ?? []).map(mapEndpointRow)
}

export async function getWebhookEndpointByIdForUser(input: {
	db: D1Database
	userId: string
	endpointId: string
}): Promise<WebhookEndpointRecord | null> {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM webhook_endpoints
			WHERE id = ? AND user_id = ?
			LIMIT 1`,
		)
		.bind(input.endpointId, input.userId)
		.first<WebhookEndpointRow>()
	return row ? mapEndpointRow(row) : null
}

/** Ingress lookup by id only; caller must re-check username ownership. */
export async function getWebhookEndpointById(input: {
	db: D1Database
	endpointId: string
}): Promise<WebhookEndpointRecord | null> {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM webhook_endpoints
			WHERE id = ?
			LIMIT 1`,
		)
		.bind(input.endpointId)
		.first<WebhookEndpointRow>()
	return row ? mapEndpointRow(row) : null
}

export async function updateWebhookEndpoint(input: {
	db: D1Database
	userId: string
	endpointId: string
	name?: string
	packageId?: string
	exportName?: string
	urlSecretHash?: string
	verificationConfig?: StoredWebhookVerificationConfig | null
	clearVerificationConfig?: boolean
	responseMode?: WebhookResponseMode
	enabled?: boolean
	now?: string
}): Promise<WebhookEndpointRecord | null> {
	const existing = await getWebhookEndpointByIdForUser({
		db: input.db,
		userId: input.userId,
		endpointId: input.endpointId,
	})
	if (!existing) return null

	const now = input.now ?? new Date().toISOString()
	const name = input.name ?? existing.name
	const packageId = input.packageId ?? existing.packageId
	const exportName = input.exportName ?? existing.exportName
	const urlSecretHash = input.urlSecretHash ?? existing.urlSecretHash
	const responseMode = input.responseMode ?? existing.responseMode
	const enabled =
		input.enabled === undefined
			? existing.enabled
				? 1
				: 0
			: input.enabled
				? 1
				: 0

	let verificationConfig = existing.verificationConfig
	if (input.clearVerificationConfig) {
		verificationConfig = null
	} else if (input.verificationConfig !== undefined) {
		verificationConfig = input.verificationConfig
	}
	const verificationConfigJson = verificationConfig
		? serializeStoredWebhookVerificationConfig(verificationConfig)
		: null

	await input.db
		.prepare(
			`UPDATE webhook_endpoints
			SET name = ?,
				package_id = ?,
				export_name = ?,
				url_secret_hash = ?,
				verification_config = ?,
				response_mode = ?,
				enabled = ?,
				updated_at = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			name,
			packageId,
			exportName,
			urlSecretHash,
			verificationConfigJson,
			responseMode,
			enabled,
			now,
			input.endpointId,
			input.userId,
		)
		.run()

	return {
		id: existing.id,
		userId: existing.userId,
		name,
		packageId,
		exportName,
		urlSecretHash,
		verificationConfig,
		responseMode,
		enabled: enabled === 1,
		createdAt: existing.createdAt,
		updatedAt: now,
	}
}

export async function deleteWebhookEndpoint(input: {
	db: D1Database
	userId: string
	endpointId: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`DELETE FROM webhook_endpoints
			WHERE id = ? AND user_id = ?`,
		)
		.bind(input.endpointId, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function insertWebhookDelivery(input: {
	db: D1Database
	id: string
	endpointId: string
	userId: string
	receivedAt: string
	outcome: WebhookDeliveryOutcome
	httpStatus: number
	error?: string | null
	payloadBytes: number
}): Promise<WebhookDeliveryRecord> {
	const error = truncateDeliveryError(input.error)
	await input.db
		.prepare(
			`INSERT INTO webhook_deliveries (
				id, endpoint_id, user_id, received_at, outcome, http_status, error, payload_bytes
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.endpointId,
			input.userId,
			input.receivedAt,
			input.outcome,
			input.httpStatus,
			error,
			input.payloadBytes,
		)
		.run()

	// Keep only the most recent N rows per endpoint.
	await input.db
		.prepare(
			`DELETE FROM webhook_deliveries
			WHERE endpoint_id = ?
				AND id NOT IN (
					SELECT id
					FROM webhook_deliveries
					WHERE endpoint_id = ?
					ORDER BY received_at DESC, id DESC
					LIMIT ?
				)`,
		)
		.bind(
			input.endpointId,
			input.endpointId,
			webhookDeliveriesRetainedPerEndpoint,
		)
		.run()

	return {
		id: input.id,
		endpointId: input.endpointId,
		userId: input.userId,
		receivedAt: input.receivedAt,
		outcome: input.outcome,
		httpStatus: input.httpStatus,
		error,
		payloadBytes: input.payloadBytes,
	}
}

export async function listWebhookDeliveriesForEndpoint(input: {
	db: D1Database
	userId: string
	endpointId: string
	limit?: number
}): Promise<Array<WebhookDeliveryRecord>> {
	const limit = Math.min(Math.max(input.limit ?? 50, 1), 50)
	const result = await input.db
		.prepare(
			`SELECT *
			FROM webhook_deliveries
			WHERE endpoint_id = ? AND user_id = ?
			ORDER BY received_at DESC, id DESC
			LIMIT ?`,
		)
		.bind(input.endpointId, input.userId, limit)
		.all<WebhookDeliveryRow>()
	return (result.results ?? []).map(mapDeliveryRow)
}
