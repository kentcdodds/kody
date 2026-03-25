import {
	type ConnectionDraftRow,
	type ConnectionDraftSecretRow,
} from './connection-drafts-types.ts'
import { resolveFieldUpdate } from './resolve-field-update.ts'

export async function insertConnectionDraft(
	db: D1Database,
	row: Omit<ConnectionDraftRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
) {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO connection_drafts (
				id, user_id, provider_key, display_name, label, auth_spec_json, status,
				state_json, error_message, created_at, updated_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.provider_key,
			row.display_name,
			row.label,
			row.auth_spec_json,
			row.status,
			row.state_json,
			row.error_message,
			row.created_at ?? now,
			row.updated_at ?? now,
			row.expires_at,
		)
		.run()
}

export async function getConnectionDraftById(
	db: D1Database,
	userId: string,
	draftId: string,
): Promise<ConnectionDraftRow | null> {
	const result = await db
		.prepare(
			`SELECT id, user_id, provider_key, display_name, label, auth_spec_json, status,
				state_json, error_message, created_at, updated_at, expires_at
			FROM connection_drafts
			WHERE id = ? AND user_id = ?`,
		)
		.bind(draftId, userId)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapConnectionDraftRow(result)
}

export async function getConnectionDraftByIdUnsafe(
	db: D1Database,
	draftId: string,
): Promise<ConnectionDraftRow | null> {
	const result = await db
		.prepare(
			`SELECT id, user_id, provider_key, display_name, label, auth_spec_json, status,
				state_json, error_message, created_at, updated_at, expires_at
			FROM connection_drafts
			WHERE id = ?`,
		)
		.bind(draftId)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapConnectionDraftRow(result)
}

export async function updateConnectionDraft(
	db: D1Database,
	draftId: string,
	userId: string,
	fields: {
		status?: string
		state_json?: string | null
		error_message?: string | null
		expires_at?: string
	},
) {
	const now = new Date().toISOString()
	const existing = await getConnectionDraftById(db, userId, draftId)
	if (!existing) return false
	await db
		.prepare(
			`UPDATE connection_drafts
			SET status = ?, state_json = ?, error_message = ?, expires_at = ?, updated_at = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			resolveFieldUpdate(fields, 'status', existing.status),
			resolveFieldUpdate(fields, 'state_json', existing.state_json),
			resolveFieldUpdate(fields, 'error_message', existing.error_message),
			resolveFieldUpdate(fields, 'expires_at', existing.expires_at),
			now,
			draftId,
			userId,
		)
		.run()
	return true
}

export async function updateConnectionDraftUnsafe(
	db: D1Database,
	draftId: string,
	fields: {
		status?: string
		state_json?: string | null
		error_message?: string | null
		expires_at?: string
	},
) {
	const now = new Date().toISOString()
	const existing = await getConnectionDraftByIdUnsafe(db, draftId)
	if (!existing) return false
	await db
		.prepare(
			`UPDATE connection_drafts
			SET status = ?, state_json = ?, error_message = ?, expires_at = ?, updated_at = ?
			WHERE id = ?`,
		)
		.bind(
			resolveFieldUpdate(fields, 'status', existing.status),
			resolveFieldUpdate(fields, 'state_json', existing.state_json),
			resolveFieldUpdate(fields, 'error_message', existing.error_message),
			resolveFieldUpdate(fields, 'expires_at', existing.expires_at),
			now,
			draftId,
		)
		.run()
	return true
}

export async function deleteConnectionDraft(
	db: D1Database,
	userId: string,
	draftId: string,
) {
	const out = await db
		.prepare(`DELETE FROM connection_drafts WHERE id = ? AND user_id = ?`)
		.bind(draftId, userId)
		.run()
	return (out.meta.changes ?? 0) > 0
}

export async function upsertConnectionDraftSecret(
	db: D1Database,
	row: Omit<ConnectionDraftSecretRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
) {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO connection_draft_secrets (
				draft_id, secret_name, encrypted_value, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(draft_id, secret_name) DO UPDATE SET
				encrypted_value = excluded.encrypted_value,
				updated_at = excluded.updated_at`,
		)
		.bind(
			row.draft_id,
			row.secret_name,
			row.encrypted_value,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function listConnectionDraftSecrets(
	db: D1Database,
	draftId: string,
): Promise<Array<ConnectionDraftSecretRow>> {
	const { results } = await db
		.prepare(
			`SELECT draft_id, secret_name, encrypted_value, created_at, updated_at
			FROM connection_draft_secrets
			WHERE draft_id = ?`,
		)
		.bind(draftId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapConnectionDraftSecretRow)
}

export async function getConnectionDraftSecret(
	db: D1Database,
	draftId: string,
	secretName: string,
): Promise<ConnectionDraftSecretRow | null> {
	const result = await db
		.prepare(
			`SELECT draft_id, secret_name, encrypted_value, created_at, updated_at
			FROM connection_draft_secrets
			WHERE draft_id = ? AND secret_name = ?`,
		)
		.bind(draftId, secretName)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapConnectionDraftSecretRow(result)
}

export async function deleteConnectionDraftSecrets(
	db: D1Database,
	draftId: string,
) {
	await db
		.prepare(`DELETE FROM connection_draft_secrets WHERE draft_id = ?`)
		.bind(draftId)
		.run()
}

function mapConnectionDraftRow(
	row: Record<string, unknown>,
): ConnectionDraftRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']),
		provider_key: String(row['provider_key']),
		display_name: String(row['display_name']),
		label: row['label'] == null ? null : String(row['label']),
		auth_spec_json: String(row['auth_spec_json']),
		status: String(row['status']),
		state_json: row['state_json'] == null ? null : String(row['state_json']),
		error_message:
			row['error_message'] == null ? null : String(row['error_message']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
		expires_at: String(row['expires_at']),
	}
}

function mapConnectionDraftSecretRow(
	row: Record<string, unknown>,
): ConnectionDraftSecretRow {
	return {
		draft_id: String(row['draft_id']),
		secret_name: String(row['secret_name']),
		encrypted_value: String(row['encrypted_value']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}
