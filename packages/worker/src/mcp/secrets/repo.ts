import {
	type SecretBucketRow,
	type SecretEntryRow,
	type SecretScope,
} from './types.ts'

type SecretMetadataRow = {
	scope: SecretScope
	binding_key: string
	name: string
	description: string
	allowed_hosts: string
	allowed_capabilities: string
	allowed_packages: string
	created_at: string
	updated_at: string
	expires_at: string | null
}

export async function getSecretBucket(input: {
	db: D1Database
	userId: string
	scope: SecretScope
	bindingKey: string
	now?: string
}): Promise<SecretBucketRow | null> {
	const now = input.now ?? new Date().toISOString()
	const row = await input.db
		.prepare(
			`SELECT id, user_id, scope, binding_key, expires_at, created_at, updated_at
			FROM secret_buckets
			WHERE user_id = ? AND scope = ? AND binding_key = ?
				AND (expires_at IS NULL OR expires_at > ?)
			LIMIT 1`,
		)
		.bind(input.userId, input.scope, input.bindingKey, now)
		.first<Record<string, unknown>>()
	return row ? mapSecretBucketRow(row) : null
}

export async function upsertSecretBucket(input: {
	db: D1Database
	row: Omit<SecretBucketRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, expires_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, scope, binding_key)
			DO UPDATE SET
				expires_at = excluded.expires_at,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.row.id,
			input.row.user_id,
			input.row.scope,
			input.row.binding_key,
			input.row.expires_at,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
		)
		.run()
}

export async function getSecretEntry(input: {
	db: D1Database
	bucketId: string
	name: string
}): Promise<SecretEntryRow | null> {
	const row = await input.db
		.prepare(
			`SELECT bucket_id, name, description, encrypted_value, allowed_hosts, allowed_capabilities, allowed_packages, created_at, updated_at
			FROM secret_entries
			WHERE bucket_id = ? AND name = ?
			LIMIT 1`,
		)
		.bind(input.bucketId, input.name)
		.first<Record<string, unknown>>()
	return row ? mapSecretEntryRow(row) : null
}

export async function upsertSecretEntry(input: {
	db: D1Database
	row: Omit<SecretEntryRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO secret_entries (
				bucket_id, name, description, encrypted_value, allowed_hosts, allowed_capabilities, allowed_packages, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(bucket_id, name)
			DO UPDATE SET
				description = excluded.description,
				encrypted_value = excluded.encrypted_value,
				allowed_hosts = excluded.allowed_hosts,
				allowed_capabilities = excluded.allowed_capabilities,
				allowed_packages = excluded.allowed_packages,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.row.bucket_id,
			input.row.name,
			input.row.description,
			input.row.encrypted_value,
			input.row.allowed_hosts,
			input.row.allowed_capabilities,
			input.row.allowed_packages,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
		)
		.run()
}

export async function deleteSecretEntry(input: {
	db: D1Database
	bucketId: string
	name: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(`DELETE FROM secret_entries WHERE bucket_id = ? AND name = ?`)
		.bind(input.bucketId, input.name)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function listSecretMetadataForBucket(input: {
	db: D1Database
	bucket: SecretBucketRow
}): Promise<Array<SecretMetadataRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT ? AS scope, ? AS binding_key, name, description, allowed_hosts, allowed_capabilities, allowed_packages, created_at, updated_at, ? AS expires_at
			FROM secret_entries
			WHERE bucket_id = ?
			ORDER BY name ASC`,
		)
		.bind(
			input.bucket.scope,
			input.bucket.binding_key,
			input.bucket.expires_at,
			input.bucket.id,
		)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapSecretMetadataRow)
}

export async function listUserScopeSecretMetadata(input: {
	db: D1Database
	userId: string
	now?: string
}): Promise<Array<SecretMetadataRow>> {
	const now = input.now ?? new Date().toISOString()
	const { results } = await input.db
		.prepare(
			`SELECT b.scope, b.binding_key, e.name, e.description, e.allowed_hosts, e.allowed_capabilities, e.allowed_packages, e.created_at, e.updated_at, b.expires_at
			FROM secret_buckets b
			JOIN secret_entries e ON e.bucket_id = b.id
			WHERE b.user_id = ? AND b.scope = 'user'
				AND (b.expires_at IS NULL OR b.expires_at > ?)
			ORDER BY e.name ASC`,
		)
		.bind(input.userId, now)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapSecretMetadataRow)
}

export async function listAppScopeSecretMetadata(input: {
	db: D1Database
	userId: string
	appIds: Array<string>
	now?: string
}): Promise<Array<SecretMetadataRow>> {
	if (input.appIds.length === 0) return []
	const now = input.now ?? new Date().toISOString()
	const placeholders = input.appIds.map(() => '?').join(', ')
	const { results } = await input.db
		.prepare(
			`SELECT b.scope, b.binding_key, e.name, e.description, e.allowed_hosts, e.allowed_capabilities, e.allowed_packages, e.created_at, e.updated_at, b.expires_at
			FROM secret_buckets b
			JOIN secret_entries e ON e.bucket_id = b.id
			WHERE b.user_id = ? AND b.scope = 'app'
				AND b.binding_key IN (${placeholders})
				AND (b.expires_at IS NULL OR b.expires_at > ?)
			ORDER BY e.name ASC`,
		)
		.bind(input.userId, ...input.appIds, now)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapSecretMetadataRow)
}

export async function deleteAppScopeSecretBuckets(input: {
	db: D1Database
	userId: string
	appId: string
}) {
	const result = await input.db
		.prepare(
			`DELETE FROM secret_buckets
			WHERE user_id = ? AND scope = 'app' AND binding_key = ?`,
		)
		.bind(input.userId, input.appId)
		.run()
	return result.meta.changes ?? 0
}

function mapSecretBucketRow(row: Record<string, unknown>): SecretBucketRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']),
		scope: String(row['scope']) as SecretScope,
		binding_key: String(row['binding_key']),
		expires_at: row['expires_at'] == null ? null : String(row['expires_at']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}

function mapSecretEntryRow(row: Record<string, unknown>): SecretEntryRow {
	return {
		bucket_id: String(row['bucket_id']),
		name: String(row['name']),
		description: String(row['description']),
		encrypted_value: String(row['encrypted_value']),
		allowed_hosts: String(row['allowed_hosts']),
		allowed_capabilities: String(row['allowed_capabilities']),
		allowed_packages: String(row['allowed_packages']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}

function mapSecretMetadataRow(row: Record<string, unknown>): SecretMetadataRow {
	return {
		scope: String(row['scope']) as SecretScope,
		binding_key: String(row['binding_key']),
		name: String(row['name']),
		description: String(row['description']),
		allowed_hosts: String(row['allowed_hosts']),
		allowed_capabilities: String(row['allowed_capabilities']),
		allowed_packages: String(row['allowed_packages']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
		expires_at: row['expires_at'] == null ? null : String(row['expires_at']),
	}
}
