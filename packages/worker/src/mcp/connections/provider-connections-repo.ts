import {
	type ProviderConnectionRow,
	type ProviderConnectionSecretRow,
} from './provider-connections-types.ts'
import { resolveFieldUpdate } from './resolve-field-update.ts'

export async function insertProviderConnection(
	db: D1Database,
	row: Omit<ProviderConnectionRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
) {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO provider_connections (
				id, user_id, provider_key, display_name, label, auth_spec_json, status,
				account_id, account_label, scope_set, metadata_json, is_default,
				token_expires_at, last_used_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.provider_key,
			row.display_name,
			row.label,
			row.auth_spec_json,
			row.status,
			row.account_id,
			row.account_label,
			row.scope_set,
			row.metadata_json,
			row.is_default,
			row.token_expires_at,
			row.last_used_at,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function getProviderConnectionById(
	db: D1Database,
	userId: string,
	connectionId: string,
): Promise<ProviderConnectionRow | null> {
	const result = await db
		.prepare(
			`SELECT id, user_id, provider_key, display_name, label, auth_spec_json, status,
				account_id, account_label, scope_set, metadata_json, is_default,
				token_expires_at, last_used_at, created_at, updated_at
			FROM provider_connections
			WHERE id = ? AND user_id = ?`,
		)
		.bind(connectionId, userId)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapProviderConnectionRow(result)
}

export async function getProviderConnectionByIdUnsafe(
	db: D1Database,
	connectionId: string,
): Promise<ProviderConnectionRow | null> {
	const result = await db
		.prepare(
			`SELECT id, user_id, provider_key, display_name, label, auth_spec_json, status,
				account_id, account_label, scope_set, metadata_json, is_default,
				token_expires_at, last_used_at, created_at, updated_at
			FROM provider_connections
			WHERE id = ?`,
		)
		.bind(connectionId)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapProviderConnectionRow(result)
}

export async function listProviderConnectionsByUserId(
	db: D1Database,
	userId: string,
): Promise<Array<ProviderConnectionRow>> {
	const { results } = await db
		.prepare(
			`SELECT id, user_id, provider_key, display_name, label, auth_spec_json, status,
				account_id, account_label, scope_set, metadata_json, is_default,
				token_expires_at, last_used_at, created_at, updated_at
			FROM provider_connections
			WHERE user_id = ?
			ORDER BY provider_key ASC, is_default DESC, label ASC`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapProviderConnectionRow)
}

export async function listProviderConnectionsByProvider(
	db: D1Database,
	userId: string,
	providerKey: string,
): Promise<Array<ProviderConnectionRow>> {
	const { results } = await db
		.prepare(
			`SELECT id, user_id, provider_key, display_name, label, auth_spec_json, status,
				account_id, account_label, scope_set, metadata_json, is_default,
				token_expires_at, last_used_at, created_at, updated_at
			FROM provider_connections
			WHERE user_id = ? AND provider_key = ?
			ORDER BY is_default DESC, label ASC`,
		)
		.bind(userId, providerKey)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapProviderConnectionRow)
}

export async function setProviderConnectionDefault(
	db: D1Database,
	userId: string,
	providerKey: string,
	connectionId: string,
) {
	await db
		.prepare(
			`UPDATE provider_connections
			SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END,
				updated_at = ?
			WHERE user_id = ? AND provider_key = ?`,
		)
		.bind(connectionId, new Date().toISOString(), userId, providerKey)
		.run()
}

export async function updateProviderConnection(
	db: D1Database,
	userId: string,
	connectionId: string,
	fields: {
		status?: string
		account_id?: string | null
		account_label?: string | null
		scope_set?: string | null
		metadata_json?: string | null
		is_default?: 0 | 1
		token_expires_at?: string | null
		last_used_at?: string | null
	},
) {
	const existing = await getProviderConnectionById(db, userId, connectionId)
	if (!existing) return false
	await db
		.prepare(
			`UPDATE provider_connections
			SET status = ?, account_id = ?, account_label = ?, scope_set = ?,
				metadata_json = ?, is_default = ?, token_expires_at = ?, last_used_at = ?,
				updated_at = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			resolveFieldUpdate(fields, 'status', existing.status),
			resolveFieldUpdate(fields, 'account_id', existing.account_id),
			resolveFieldUpdate(fields, 'account_label', existing.account_label),
			resolveFieldUpdate(fields, 'scope_set', existing.scope_set),
			resolveFieldUpdate(fields, 'metadata_json', existing.metadata_json),
			resolveFieldUpdate(fields, 'is_default', existing.is_default),
			resolveFieldUpdate(fields, 'token_expires_at', existing.token_expires_at),
			resolveFieldUpdate(fields, 'last_used_at', existing.last_used_at),
			new Date().toISOString(),
			connectionId,
			userId,
		)
		.run()
	return true
}

export async function deleteProviderConnection(
	db: D1Database,
	userId: string,
	connectionId: string,
) {
	const out = await db
		.prepare(`DELETE FROM provider_connections WHERE id = ? AND user_id = ?`)
		.bind(connectionId, userId)
		.run()
	return (out.meta.changes ?? 0) > 0
}

export async function upsertProviderConnectionSecret(
	db: D1Database,
	row: Omit<ProviderConnectionSecretRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
) {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO provider_connection_secrets (
				connection_id, encrypted_secret_json, created_at, updated_at
			) VALUES (?, ?, ?, ?)
			ON CONFLICT(connection_id) DO UPDATE SET
				encrypted_secret_json = excluded.encrypted_secret_json,
				updated_at = excluded.updated_at`,
		)
		.bind(
			row.connection_id,
			row.encrypted_secret_json,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function getProviderConnectionSecret(
	db: D1Database,
	connectionId: string,
): Promise<ProviderConnectionSecretRow | null> {
	const result = await db
		.prepare(
			`SELECT connection_id, encrypted_secret_json, created_at, updated_at
			FROM provider_connection_secrets
			WHERE connection_id = ?`,
		)
		.bind(connectionId)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapProviderConnectionSecretRow(result)
}

function mapProviderConnectionRow(
	row: Record<string, unknown>,
): ProviderConnectionRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']),
		provider_key: String(row['provider_key']),
		display_name: String(row['display_name']),
		label: String(row['label']),
		auth_spec_json: String(row['auth_spec_json']),
		status: String(row['status']),
		account_id: row['account_id'] == null ? null : String(row['account_id']),
		account_label:
			row['account_label'] == null ? null : String(row['account_label']),
		scope_set: row['scope_set'] == null ? null : String(row['scope_set']),
		metadata_json:
			row['metadata_json'] == null ? null : String(row['metadata_json']),
		is_default: Number(row['is_default']) === 1 ? 1 : 0,
		token_expires_at:
			row['token_expires_at'] == null ? null : String(row['token_expires_at']),
		last_used_at:
			row['last_used_at'] == null ? null : String(row['last_used_at']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}

function mapProviderConnectionSecretRow(
	row: Record<string, unknown>,
): ProviderConnectionSecretRow {
	return {
		connection_id: String(row['connection_id']),
		encrypted_secret_json: String(row['encrypted_secret_json']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}
