import {
	type EntityKind,
	type EntitySourceRow,
	entitySourceRowSchema,
} from './types.ts'

function mapEntitySourceRow(row: Record<string, unknown>): EntitySourceRow {
	return entitySourceRowSchema.parse({
		id: String(row['id']),
		user_id: String(row['user_id']),
		entity_kind: String(row['entity_kind']),
		entity_id: String(row['entity_id']),
		repo_id: String(row['repo_id']),
		published_commit:
			row['published_commit'] == null ? null : String(row['published_commit']),
		indexed_commit:
			row['indexed_commit'] == null ? null : String(row['indexed_commit']),
		manifest_path: String(row['manifest_path']),
		source_root: String(row['source_root']),
		last_external_check_at:
			row['last_external_check_at'] == null
				? null
				: String(row['last_external_check_at']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	})
}

export async function insertEntitySource(
	db: D1Database,
	row: EntitySourceRow,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit, indexed_commit,
				manifest_path, source_root, last_external_check_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.entity_kind,
			row.entity_id,
			row.repo_id,
			row.published_commit,
			row.indexed_commit,
			row.manifest_path,
			row.source_root,
			row.last_external_check_at,
			row.created_at,
			row.updated_at,
		)
		.run()
}

export async function getEntitySourceById(
	db: D1Database,
	id: string,
): Promise<EntitySourceRow | null> {
	const result = await db
		.prepare(`SELECT * FROM entity_sources WHERE id = ?`)
		.bind(id)
		.first<Record<string, unknown>>()
	return result ? mapEntitySourceRow(result) : null
}

export async function getEntitySourceByEntity(
	db: D1Database,
	input: {
		userId: string
		entityKind: EntityKind
		entityId: string
	},
): Promise<EntitySourceRow | null> {
	const result = await db
		.prepare(
			`SELECT * FROM entity_sources
			WHERE user_id = ? AND entity_kind = ? AND entity_id = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.entityKind, input.entityId)
		.first<Record<string, unknown>>()
	return result ? mapEntitySourceRow(result) : null
}

export async function listEntitySourcesByUser(
	db: D1Database,
	userId: string,
): Promise<Array<EntitySourceRow>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM entity_sources
			WHERE user_id = ?
			ORDER BY updated_at DESC, created_at DESC`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapEntitySourceRow)
}

export async function updateEntitySource(
	db: D1Database,
	input: {
		id: string
		userId: string
		repoId?: string
		publishedCommit?: string | null
		indexedCommit?: string | null
		manifestPath?: string
		sourceRoot?: string
		lastExternalCheckAt?: string | null
	},
): Promise<boolean> {
	const assignments: Array<string> = []
	const values: Array<unknown> = []
	const add = (column: string, value: unknown) => {
		assignments.push(`${column} = ?`)
		values.push(value)
	}
	if (input.repoId !== undefined) add('repo_id', input.repoId)
	if (input.publishedCommit !== undefined) {
		add('published_commit', input.publishedCommit)
	}
	if (input.indexedCommit !== undefined)
		add('indexed_commit', input.indexedCommit)
	if (input.manifestPath !== undefined) add('manifest_path', input.manifestPath)
	if (input.sourceRoot !== undefined) add('source_root', input.sourceRoot)
	if (input.lastExternalCheckAt !== undefined) {
		add('last_external_check_at', input.lastExternalCheckAt)
	}
	add('updated_at', new Date().toISOString())
	const result = await db
		.prepare(
			`UPDATE entity_sources
			SET ${assignments.join(', ')}
			WHERE id = ? AND user_id = ?`,
		)
		.bind(...values, input.id, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function upsertEntitySource(
	db: D1Database,
	row: EntitySourceRow,
): Promise<void> {
	const existing = await getEntitySourceByEntity(db, {
		userId: row.user_id,
		entityKind: row.entity_kind,
		entityId: row.entity_id,
	})
	if (existing) {
		await updateEntitySource(db, {
			id: existing.id,
			userId: row.user_id,
			repoId: row.repo_id,
			publishedCommit: row.published_commit,
			indexedCommit: row.indexed_commit,
			manifestPath: row.manifest_path,
			sourceRoot: row.source_root,
		})
		return
	}
	await insertEntitySource(db, row)
}

export async function listEntitySourcesForExternalReconcile(
	db: D1Database,
	input: {
		before: string
		limit: number
	},
): Promise<Array<EntitySourceRow>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM entity_sources
			WHERE last_external_check_at IS NULL OR last_external_check_at < ?
			ORDER BY COALESCE(last_external_check_at, created_at) ASC
			LIMIT ?`,
		)
		.bind(input.before, input.limit)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapEntitySourceRow)
}

export async function deleteEntitySource(
	db: D1Database,
	input: {
		id: string
		userId: string
	},
): Promise<boolean> {
	const result = await db
		.prepare(`DELETE FROM entity_sources WHERE id = ? AND user_id = ?`)
		.bind(input.id, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}
