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

function prepareUpsertSecretEntryStatement(input: {
	db: D1Database
	row: Omit<SecretEntryRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): D1PreparedStatement {
	const now = new Date().toISOString()
	return input.db
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
}

export async function upsertSecretEntry(input: {
	db: D1Database
	row: Omit<SecretEntryRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	await prepareUpsertSecretEntryStatement(input).run()
}

/**
 * Persist multiple secret entry upserts in one D1 batch so a worker eviction
 * cannot leave a partial write. Statement order is preserved (callers that
 * rotate OAuth refresh tokens must put the refresh-token write first).
 */
export async function upsertSecretEntriesAtomically(input: {
	db: D1Database
	rows: Array<
		Omit<SecretEntryRow, 'created_at' | 'updated_at'> & {
			created_at?: string
			updated_at?: string
		}
	>
}): Promise<void> {
	if (input.rows.length === 0) return
	await input.db.batch(
		input.rows.map((row) =>
			prepareUpsertSecretEntryStatement({ db: input.db, row }),
		),
	)
}

function prepareUpdateApprovedUserSecretEntryForPackageStatement(input: {
	db: D1Database
	userId: string
	packageId: string
	name: string
	description: string
	encryptedValue: string
	updatedAt: string
}): D1PreparedStatement {
	return input.db
		.prepare(
			`UPDATE secret_entries
			SET description = ?, encrypted_value = ?, updated_at = ?
			WHERE name = ?
				AND bucket_id = (
					SELECT id
					FROM secret_buckets
					WHERE user_id = ? AND scope = 'user' AND binding_key = ''
					LIMIT 1
				)
				AND json_valid(allowed_packages)
				AND EXISTS (
					SELECT 1
					FROM json_each(allowed_packages)
					WHERE value = ?
				)`,
		)
		.bind(
			input.description,
			input.encryptedValue,
			input.updatedAt,
			input.name,
			input.userId,
			input.packageId,
		)
}

export async function updateApprovedUserSecretEntryForPackage(input: {
	db: D1Database
	userId: string
	packageId: string
	name: string
	description: string
	encryptedValue: string
	updatedAt: string
}): Promise<boolean> {
	const result =
		await prepareUpdateApprovedUserSecretEntryForPackageStatement(input).run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Atomically update multiple package-approved user secrets. Uses one UPDATE so
 * either every named secret is rewritten or none are (fail-closed when any
 * secret is missing or lacks the package in `allowed_packages`). Statement
 * order of `updates` is preserved in the CASE bindings for determinism.
 */
export async function updateApprovedUserSecretEntriesForPackageAtomically(input: {
	db: D1Database
	userId: string
	packageId: string
	updates: Array<{
		name: string
		description: string
		encryptedValue: string
		updatedAt: string
	}>
}): Promise<void> {
	if (input.updates.length === 0) return
	if (input.updates.length === 1) {
		const only = input.updates[0]
		if (!only) return
		const updated = await updateApprovedUserSecretEntryForPackage({
			db: input.db,
			userId: input.userId,
			packageId: input.packageId,
			name: only.name,
			description: only.description,
			encryptedValue: only.encryptedValue,
			updatedAt: only.updatedAt,
		})
		if (!updated) {
			throw new Error('package cannot mutate one or more secrets')
		}
		return
	}

	const names = input.updates.map((update) => update.name)
	const namePlaceholders = names.map(() => '?').join(', ')
	const descriptionCase = names.map(() => 'WHEN ? THEN ?').join(' ')
	const encryptedCase = names.map(() => 'WHEN ? THEN ?').join(' ')
	const updatedAt = input.updates[0]?.updatedAt
	if (!updatedAt) {
		throw new Error('At least one secret update is required.')
	}

	const result = await input.db
		.prepare(
			`UPDATE secret_entries
			SET
				description = CASE name ${descriptionCase} ELSE description END,
				encrypted_value = CASE name ${encryptedCase} ELSE encrypted_value END,
				updated_at = ?
			WHERE name IN (${namePlaceholders})
				AND bucket_id = (
					SELECT id
					FROM secret_buckets
					WHERE user_id = ? AND scope = 'user' AND binding_key = ''
					LIMIT 1
				)
				AND json_valid(allowed_packages)
				AND EXISTS (
					SELECT 1
					FROM json_each(allowed_packages)
					WHERE value = ?
				)
				AND (
					SELECT COUNT(*)
					FROM secret_entries e
					JOIN secret_buckets b ON b.id = e.bucket_id
					WHERE b.user_id = ?
						AND b.scope = 'user'
						AND b.binding_key = ''
						AND e.name IN (${namePlaceholders})
						AND json_valid(e.allowed_packages)
						AND EXISTS (
							SELECT 1
							FROM json_each(e.allowed_packages)
							WHERE value = ?
						)
				) = ?`,
		)
		.bind(
			...input.updates.flatMap((update) => [update.name, update.description]),
			...input.updates.flatMap((update) => [
				update.name,
				update.encryptedValue,
			]),
			updatedAt,
			...names,
			input.userId,
			input.packageId,
			input.userId,
			...names,
			input.packageId,
			names.length,
		)
		.run()

	if ((result.meta.changes ?? 0) !== names.length) {
		throw new Error('package cannot mutate one or more secrets')
	}
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

export async function listPackageScopeSecretMetadata(input: {
	db: D1Database
	userId: string
	packageIds: Array<string>
	now?: string
}): Promise<Array<SecretMetadataRow>> {
	if (input.packageIds.length === 0) return []
	const now = input.now ?? new Date().toISOString()
	const placeholders = input.packageIds.map(() => '?').join(', ')
	const { results } = await input.db
		.prepare(
			`SELECT b.scope, b.binding_key, e.name, e.description, e.allowed_hosts, e.allowed_capabilities, e.allowed_packages, e.created_at, e.updated_at, b.expires_at
			FROM secret_buckets b
			JOIN secret_entries e ON e.bucket_id = b.id
			WHERE b.user_id = ? AND b.scope = 'package'
				AND b.binding_key IN (${placeholders})
				AND (b.expires_at IS NULL OR b.expires_at > ?)
			ORDER BY e.name ASC`,
		)
		.bind(input.userId, ...input.packageIds, now)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapSecretMetadataRow)
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
