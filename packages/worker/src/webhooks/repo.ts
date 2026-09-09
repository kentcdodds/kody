import { type WebhookEndpointRecord } from './types.ts'

type WebhookEndpointRow = {
	id: string
	user_id: string
	package_id: string
	webhook_name: string
	url_secret_hash: string
	url_secret_encrypted?: string | null
	enabled: number
	created_at: string
	rotated_at: string
}

function mapEndpointRow(row: WebhookEndpointRow): WebhookEndpointRecord {
	return {
		id: row.id,
		userId: row.user_id,
		packageId: row.package_id,
		webhookName: row.webhook_name,
		urlSecretHash: row.url_secret_hash,
		urlSecretEncrypted: row.url_secret_encrypted ?? null,
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		rotatedAt: row.rotated_at,
	}
}

/**
 * Insert or rotate a minted webhook URL secret. Hash and ciphertext are written
 * in the same statement. The caller encrypts with `id` as AAD, so `id` must be
 * the existing endpoint id on update.
 *
 * When `updateEnabledOnConflict` is true (mint/activate), updates also set
 * `enabled`. Rotate passes false so disable state sticks.
 */
export async function upsertWebhookEndpointSecret(input: {
	db: D1Database
	id: string
	userId: string
	packageId: string
	webhookName: string
	urlSecretHash: string
	urlSecretEncrypted: string
	enabled?: boolean
	updateEnabledOnConflict?: boolean
	now?: string
}): Promise<WebhookEndpointRecord> {
	const now = input.now ?? new Date().toISOString()
	const enabled = input.enabled === false ? 0 : 1
	const existing = await getWebhookEndpointByKey({
		db: input.db,
		userId: input.userId,
		packageId: input.packageId,
		webhookName: input.webhookName,
	})
	if (existing) {
		if (existing.id !== input.id) {
			throw new Error('Unable to upsert webhook endpoint.')
		}
		const result = input.updateEnabledOnConflict
			? await input.db
					.prepare(
						`UPDATE webhook_endpoints
						SET url_secret_hash = ?, url_secret_encrypted = ?, rotated_at = ?, enabled = ?
						WHERE user_id = ? AND id = ?`,
					)
					.bind(
						input.urlSecretHash,
						input.urlSecretEncrypted,
						now,
						enabled,
						input.userId,
						existing.id,
					)
					.run()
			: await input.db
					.prepare(
						`UPDATE webhook_endpoints
						SET url_secret_hash = ?, url_secret_encrypted = ?, rotated_at = ?
						WHERE user_id = ? AND id = ?`,
					)
					.bind(
						input.urlSecretHash,
						input.urlSecretEncrypted,
						now,
						input.userId,
						existing.id,
					)
					.run()
		if ((result.meta.changes ?? 0) === 0) {
			throw new Error('Unable to upsert webhook endpoint.')
		}
	} else {
		await input.db
			.prepare(
				`INSERT INTO webhook_endpoints (
					id, user_id, package_id, webhook_name, url_secret_hash,
					url_secret_encrypted, enabled, created_at, rotated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				input.userId,
				input.packageId,
				input.webhookName,
				input.urlSecretHash,
				input.urlSecretEncrypted,
				enabled,
				now,
				now,
			)
			.run()
	}
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
