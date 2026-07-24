import {
	type WebhookDeliveryOutcome,
	type WebhookDeliveryRecord,
	type WebhookEndpointRecord,
	webhookDeliveriesRetainedPerEndpoint,
	webhookDeliveryErrorMaxLength,
} from './types.ts'

type WebhookEndpointRow = {
	id: string
	user_id: string
	package_id: string
	webhook_name: string
	url_secret_hash: string
	enabled: number
	created_at: string
	rotated_at: string
}

type WebhookDeliveryRow = {
	id: string
	endpoint_id: string
	user_id: string
	package_id: string
	webhook_name: string
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
		packageId: row.package_id,
		webhookName: row.webhook_name,
		urlSecretHash: row.url_secret_hash,
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		rotatedAt: row.rotated_at,
	}
}

function mapDeliveryRow(row: WebhookDeliveryRow): WebhookDeliveryRecord {
	return {
		id: row.id,
		endpointId: row.endpoint_id,
		userId: row.user_id,
		packageId: row.package_id,
		webhookName: row.webhook_name,
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

/**
 * Insert or rotate a minted webhook URL secret.
 * Concurrent mints for the same (user, package, name) resolve via the unique
 * index instead of throwing a constraint error.
 *
 * When `updateEnabledOnConflict` is true (mint/activate), conflict updates also
 * set `enabled` from the insert row. Rotate passes false so disable state sticks.
 */
export async function upsertWebhookEndpointSecret(input: {
	db: D1Database
	id: string
	userId: string
	packageId: string
	webhookName: string
	urlSecretHash: string
	enabled?: boolean
	updateEnabledOnConflict?: boolean
	now?: string
}): Promise<WebhookEndpointRecord> {
	const now = input.now ?? new Date().toISOString()
	const enabled = input.enabled === false ? 0 : 1
	const conflictSql = input.updateEnabledOnConflict
		? `ON CONFLICT(user_id, package_id, webhook_name)
			DO UPDATE SET
				url_secret_hash = excluded.url_secret_hash,
				rotated_at = excluded.rotated_at,
				enabled = excluded.enabled`
		: `ON CONFLICT(user_id, package_id, webhook_name)
			DO UPDATE SET
				url_secret_hash = excluded.url_secret_hash,
				rotated_at = excluded.rotated_at`
	await input.db
		.prepare(
			`INSERT INTO webhook_endpoints (
				id, user_id, package_id, webhook_name, url_secret_hash,
				enabled, created_at, rotated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			${conflictSql}`,
		)
		.bind(
			input.id,
			input.userId,
			input.packageId,
			input.webhookName,
			input.urlSecretHash,
			enabled,
			now,
			now,
		)
		.run()
	const record = await getWebhookEndpointByKey({
		db: input.db,
		userId: input.userId,
		packageId: input.packageId,
		webhookName: input.webhookName,
	})
	if (!record) {
		throw new Error('Unable to upsert webhook endpoint.')
	}
	return record
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

export async function getWebhookEndpointByKey(input: {
	db: D1Database
	userId: string
	packageId: string
	webhookName: string
}): Promise<WebhookEndpointRecord | null> {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM webhook_endpoints
			WHERE user_id = ? AND package_id = ? AND webhook_name = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.packageId, input.webhookName)
		.first<WebhookEndpointRow>()
	return row ? mapEndpointRow(row) : null
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

export async function setWebhookEndpointEnabled(input: {
	db: D1Database
	userId: string
	packageId: string
	webhookName: string
	enabled: boolean
}): Promise<WebhookEndpointRecord | null> {
	const result = await input.db
		.prepare(
			`UPDATE webhook_endpoints
			SET enabled = ?
			WHERE user_id = ? AND package_id = ? AND webhook_name = ?`,
		)
		.bind(
			input.enabled ? 1 : 0,
			input.userId,
			input.packageId,
			input.webhookName,
		)
		.run()
	if ((result.meta.changes ?? 0) === 0) return null
	return getWebhookEndpointByKey({
		db: input.db,
		userId: input.userId,
		packageId: input.packageId,
		webhookName: input.webhookName,
	})
}

export async function insertWebhookDelivery(input: {
	db: D1Database
	id: string
	endpointId: string
	userId: string
	packageId: string
	webhookName: string
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
				id, endpoint_id, user_id, package_id, webhook_name,
				received_at, outcome, http_status, error, payload_bytes
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.endpointId,
			input.userId,
			input.packageId,
			input.webhookName,
			input.receivedAt,
			input.outcome,
			input.httpStatus,
			error,
			input.payloadBytes,
		)
		.run()

	await input.db
		.prepare(
			`DELETE FROM webhook_deliveries
			WHERE user_id = ?
				AND endpoint_id = ?
				AND id NOT IN (
					SELECT id FROM (
						SELECT id
						FROM webhook_deliveries
						WHERE user_id = ?
							AND endpoint_id = ?
						ORDER BY received_at DESC, id DESC
						LIMIT ?
					)
				)`,
		)
		.bind(
			input.userId,
			input.endpointId,
			input.userId,
			input.endpointId,
			webhookDeliveriesRetainedPerEndpoint,
		)
		.run()

	return {
		id: input.id,
		endpointId: input.endpointId,
		userId: input.userId,
		packageId: input.packageId,
		webhookName: input.webhookName,
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
	packageId: string
	webhookName: string
	limit?: number
}): Promise<Array<WebhookDeliveryRecord>> {
	const limit = Math.min(
		Math.max(input.limit ?? webhookDeliveriesRetainedPerEndpoint, 1),
		webhookDeliveriesRetainedPerEndpoint,
	)
	const result = await input.db
		.prepare(
			`SELECT *
			FROM webhook_deliveries
			WHERE user_id = ? AND package_id = ? AND webhook_name = ?
			ORDER BY received_at DESC, id DESC
			LIMIT ?`,
		)
		.bind(input.userId, input.packageId, input.webhookName, limit)
		.all<WebhookDeliveryRow>()
	return (result.results ?? []).map(mapDeliveryRow)
}
