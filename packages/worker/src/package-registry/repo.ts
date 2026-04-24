import { type SavedPackageRecord, type SavedPackageRow } from './types.ts'

export function savedPackageVectorId(packageId: string) {
	return `package_${packageId}`
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
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function parseTagsJson(raw: unknown) {
	if (raw == null) return []
	try {
		const parsed = JSON.parse(String(raw)) as unknown
		return Array.isArray(parsed)
			? parsed
					.filter((value): value is string => typeof value === 'string')
					.map((value) => value.trim())
					.filter((value) => value.length > 0)
			: []
	} catch {
		return []
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
				source_id, has_app, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				source_id, has_app, created_at, updated_at
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
				source_id, has_app, created_at, updated_at
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
				source_id, has_app, created_at, updated_at
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
				source_id, has_app, created_at, updated_at
			FROM saved_packages
			WHERE user_id = ?
			ORDER BY updated_at DESC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapSavedPackageRow)
}

export async function listAllSavedPackages(
	db: D1Database,
): Promise<Array<SavedPackageRecord>> {
	const rows = await db
		.prepare(
			`SELECT id, user_id, name, kody_id, description, tags_json, search_text,
				source_id, has_app, created_at, updated_at
			FROM saved_packages
			ORDER BY updated_at DESC`,
		)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapSavedPackageRow)
}
