import {
	type ValueBucketRow,
	type ValueEntryRow,
	type ValueScope,
} from './types.ts'

type ValueMetadataRow = {
	scope: ValueScope
	binding_key: string
	name: string
	description: string
	value: string
	created_at: string
	updated_at: string
	expires_at: string | null
}

export async function getValueBucket(input: {
	db: D1Database
	userId: string
	scope: ValueScope
	bindingKey: string
	now?: string
}): Promise<ValueBucketRow | null> {
	const now = input.now ?? new Date().toISOString()
	const row = await input.db
		.prepare(
			`SELECT id, user_id, scope, binding_key, expires_at, created_at, updated_at
			FROM value_buckets
			WHERE user_id = ? AND scope = ? AND binding_key = ?
				AND (expires_at IS NULL OR expires_at > ?)
			LIMIT 1`,
		)
		.bind(input.userId, input.scope, input.bindingKey, now)
		.first<Record<string, unknown>>()
	return row ? mapValueBucketRow(row) : null
}

export async function upsertValueBucket(input: {
	db: D1Database
	row: Omit<ValueBucketRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO value_buckets (
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

export async function getValueEntry(input: {
	db: D1Database
	bucketId: string
	name: string
}): Promise<ValueEntryRow | null> {
	const row = await input.db
		.prepare(
			`SELECT bucket_id, name, description, value, created_at, updated_at
			FROM value_entries
			WHERE bucket_id = ? AND name = ?
			LIMIT 1`,
		)
		.bind(input.bucketId, input.name)
		.first<Record<string, unknown>>()
	return row ? mapValueEntryRow(row) : null
}

export async function upsertValueEntry(input: {
	db: D1Database
	row: Omit<ValueEntryRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO value_entries (
				bucket_id, name, description, value, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(bucket_id, name)
			DO UPDATE SET
				description = excluded.description,
				value = excluded.value,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.row.bucket_id,
			input.row.name,
			input.row.description,
			input.row.value,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
		)
		.run()
}

export async function deleteValueEntry(input: {
	db: D1Database
	bucketId: string
	name: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(`DELETE FROM value_entries WHERE bucket_id = ? AND name = ?`)
		.bind(input.bucketId, input.name)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function listValueMetadataForBucket(input: {
	db: D1Database
	bucket: ValueBucketRow
}): Promise<Array<ValueMetadataRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT ? AS scope, ? AS binding_key, name, description, value, created_at, updated_at, ? AS expires_at
			FROM value_entries
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
	return (results ?? []).map(mapValueMetadataRow)
}

export async function deleteValueBucketByBinding(input: {
	db: D1Database
	userId: string
	scope: ValueScope
	bindingKey: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`DELETE FROM value_buckets
			WHERE user_id = ? AND scope = ? AND binding_key = ?`,
		)
		.bind(input.userId, input.scope, input.bindingKey)
		.run()
	return (result.meta.changes ?? 0) > 0
}

function mapValueBucketRow(row: Record<string, unknown>): ValueBucketRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']),
		scope: String(row['scope']) as ValueScope,
		binding_key: String(row['binding_key']),
		expires_at: row['expires_at'] == null ? null : String(row['expires_at']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}

function mapValueEntryRow(row: Record<string, unknown>): ValueEntryRow {
	return {
		bucket_id: String(row['bucket_id']),
		name: String(row['name']),
		description: String(row['description']),
		value: String(row['value']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}

function mapValueMetadataRow(row: Record<string, unknown>): ValueMetadataRow {
	return {
		scope: String(row['scope']) as ValueScope,
		binding_key: String(row['binding_key']),
		name: String(row['name']),
		description: String(row['description']),
		value: String(row['value']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
		expires_at: row['expires_at'] == null ? null : String(row['expires_at']),
	}
}
