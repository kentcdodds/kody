import { parseTagsJson } from '@kody-internal/shared/tags-json.ts'
import { buildLengthSafeVectorId } from '#mcp/capabilities/vector-ids.ts'
import { type SavedPackageRecord, type SavedPackageRow } from './types.ts'

export function savedPackageVectorId(packageId: string) {
	return buildLengthSafeVectorId({ prefix: 'package', rawId: packageId })
}

function mapSavedPackageRow(row: Record<string, unknown>): SavedPackageRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		name: String(row['name']),
		kodyId: String(row['kody_id']),
		description: String(row['description']),
		tags: parseTagsJson(row['tags_json']),
		searchText:
			row['search_text'] == null ? null : String(row['search_text']).trim(),
		sourceId: String(row['source_id']),
		hasApp:
			row['has_app'] === 1 || row['has_app'] === '1' || row['has_app'] === true,
		hidden:
			row['hidden'] === 1 || row['hidden'] === '1' || row['hidden'] === true,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}
export async function insertSavedPackage(
	db: D1Database,
	row: Omit<SavedPackageRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
) {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, tags_json, search_text,
				source_id, has_app, hidden, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.name,
			row.kody_id,
			row.description,
			row.tags_json,
			row.search_text ?? null,
			row.source_id,
			row.has_app,
			row.hidden ?? 0,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function updateSavedPackage(
	db: D1Database,
	input: {
		userId: string
		packageId: string
		name?: string
		kodyId?: string
		description?: string
		tagsJson?: string
		searchText?: string | null
		sourceId?: string
		hasApp?: boolean
		hidden?: boolean
	},
) {
	const assignments: Array<string> = []
	const values: Array<unknown> = []

	function addAssignment(column: string, value: unknown) {
		assignments.push(`${column} = ?`)
		values.push(value)
	}

	if (input.name !== undefined) {
		addAssignment('name', input.name)
	}
	if (input.kodyId !== undefined) {
		addAssignment('kody_id', input.kodyId)
	}
	if (input.description !== undefined) {
		addAssignment('description', input.description)
	}
	if (input.tagsJson !== undefined) {
		addAssignment('tags_json', input.tagsJson)
	}
	if (input.searchText !== undefined) {
		addAssignment('search_text', input.searchText ?? null)
	}
	if (input.sourceId !== undefined) {
		addAssignment('source_id', input.sourceId)
	}
	if (input.hasApp !== undefined) {
		addAssignment('has_app', input.hasApp ? 1 : 0)
	}
	if (input.hidden !== undefined) {
		addAssignment('hidden', input.hidden ? 1 : 0)
	}

	addAssignment('updated_at', new Date().toISOString())

	const result = await db
		.prepare(
			`UPDATE saved_packages
			SET ${assignments.join(', ')}
			WHERE id = ? AND user_id = ?`,
		)
		.bind(...values, input.packageId, input.userId)
		.run()

	return (result.meta.changes ?? 0) > 0
}

export async function deleteSavedPackage(
	db: D1Database,
	input: {
		userId: string
		packageId: string
	},
) {
	const result = await db
		.prepare(`DELETE FROM saved_packages WHERE id = ? AND user_id = ?`)
		.bind(input.packageId, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function getSavedPackageById(
	db: D1Database,
	input: {
		userId: string
		packageId: string
	},
): Promise<SavedPackageRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, name, kody_id, description, tags_json, search_text,
				source_id, has_app, hidden, created_at, updated_at
			FROM saved_packages
			WHERE id = ? AND user_id = ?`,
		)
		.bind(input.packageId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapSavedPackageRow(row) : null
}

export async function getSavedPackageByKodyId(
	db: D1Database,
	input: {
		userId: string
		kodyId: string
	},
): Promise<SavedPackageRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, name, kody_id, description, tags_json, search_text,
				source_id, has_app, hidden, created_at, updated_at
			FROM saved_packages
			WHERE kody_id = ? AND user_id = ?`,
		)
		.bind(input.kodyId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapSavedPackageRow(row) : null
}

export async function getSavedPackageByName(
	db: D1Database,
	input: {
		userId: string
		name: string
	},
): Promise<SavedPackageRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, name, kody_id, description, tags_json, search_text,
				source_id, has_app, hidden, created_at, updated_at
			FROM saved_packages
			WHERE name = ? AND user_id = ?`,
		)
		.bind(input.name, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapSavedPackageRow(row) : null
}

export async function listSavedPackagesByUserId(
	db: D1Database,
	input: {
		userId: string
	},
): Promise<Array<SavedPackageRecord>> {
	const rows = await db
		.prepare(
			`SELECT id, user_id, name, kody_id, description, tags_json, search_text,
				source_id, has_app, hidden, created_at, updated_at
			FROM saved_packages
			WHERE user_id = ?
			ORDER BY updated_at DESC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapSavedPackageRow)
}

export type SavedPackageSearchSort = 'updated' | 'created' | 'name'

/** Escape LIKE wildcards so user queries match literally. */
function escapeLikePattern(value: string) {
	return value.replaceAll(/[\\%_]/g, (character) => `\\${character}`)
}

function savedPackageSearchOrderBy(sort: SavedPackageSearchSort) {
	switch (sort) {
		case 'updated':
			return 'updated_at DESC, id ASC'
		case 'created':
			return 'created_at DESC, id ASC'
		case 'name':
			return 'name COLLATE NOCASE ASC, id ASC'
		default:
			sort satisfies never
			throw new Error(`Unknown saved package sort: ${String(sort)}`)
	}
}

/**
 * Filtered, paged listing of one user's saved packages for browse UIs. The
 * query and count share the same WHERE clause so the reported total always
 * matches the filtered result set.
 */
export async function searchSavedPackagesByUserId(
	db: D1Database,
	input: {
		userId: string
		query?: string
		hasApp?: boolean | null
		sort?: SavedPackageSearchSort
		limit: number
		offset: number
	},
): Promise<{ items: Array<SavedPackageRecord>; total: number }> {
	const conditions = ['user_id = ?']
	const params: Array<unknown> = [input.userId]
	const query = input.query?.trim() ?? ''
	if (query) {
		const pattern = `%${escapeLikePattern(query.toLowerCase())}%`
		conditions.push(
			`(LOWER(name) LIKE ? ESCAPE '\\'
				OR LOWER(kody_id) LIKE ? ESCAPE '\\'
				OR LOWER(description) LIKE ? ESCAPE '\\'
				OR LOWER(COALESCE(search_text, '')) LIKE ? ESCAPE '\\'
				OR LOWER(tags_json) LIKE ? ESCAPE '\\')`,
		)
		params.push(pattern, pattern, pattern, pattern, pattern)
	}
	if (input.hasApp != null) {
		conditions.push('has_app = ?')
		params.push(input.hasApp ? 1 : 0)
	}
	const whereClause = `WHERE ${conditions.join(' AND ')}`
	const orderBy = savedPackageSearchOrderBy(input.sort ?? 'updated')

	const [totalRow, rows] = await Promise.all([
		db
			.prepare(`SELECT COUNT(*) AS total FROM saved_packages ${whereClause}`)
			.bind(...params)
			.first<{ total: number }>(),
		db
			.prepare(
				`SELECT id, user_id, name, kody_id, description, tags_json, search_text,
					source_id, has_app, hidden, created_at, updated_at
				FROM saved_packages
				${whereClause}
				ORDER BY ${orderBy}
				LIMIT ? OFFSET ?`,
			)
			.bind(...params, input.limit, input.offset)
			.all<Record<string, unknown>>(),
	])
	return {
		items: (rows.results ?? []).map(mapSavedPackageRow),
		total: totalRow?.total ?? 0,
	}
}

// Keyset-paged listing across all users, used by maintenance reindex so a
// single query never loads the whole table. Pass the last row id of the
// previous page (or null for the first page).
export async function listSavedPackagesPage(
	db: D1Database,
	input: {
		afterId: string | null
		limit: number
	},
): Promise<Array<SavedPackageRecord>> {
	const rows = await db
		.prepare(
			`SELECT id, user_id, name, kody_id, description, tags_json, search_text,
				source_id, has_app, hidden, created_at, updated_at
			FROM saved_packages
			WHERE id > ?
			ORDER BY id
			LIMIT ?`,
		)
		.bind(input.afterId ?? '', input.limit)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapSavedPackageRow)
}
