import { type UiArtifactRow } from './ui-artifacts-types.ts'

export function uiArtifactVectorId(artifactId: string): string {
	return `ui_artifact_${artifactId}`
}

export async function insertUiArtifact(
	db: D1Database,
	row: Omit<UiArtifactRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
): Promise<void> {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO ui_artifacts (
				id, user_id, title, description, keywords, source_code, source_type,
				search_text, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.title,
			row.description,
			row.keywords,
			row.code,
			row.runtime,
			row.search_text ?? null,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function getUiArtifactById(
	db: D1Database,
	userId: string,
	artifactId: string,
): Promise<UiArtifactRow | null> {
	const result = await db
		.prepare(
			`SELECT id, user_id, title, description, keywords, source_code, source_type,
				search_text, created_at, updated_at
			FROM ui_artifacts WHERE id = ? AND user_id = ?`,
		)
		.bind(artifactId, userId)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapRow(result)
}

export async function getUiArtifactByOwnerIds(
	db: D1Database,
	userIds: Array<string>,
	artifactId: string,
): Promise<UiArtifactRow | null> {
	const ownerIds = userIds.map((userId) => userId.trim()).filter(Boolean)
	if (ownerIds.length === 0) return null

	const placeholders = ownerIds.map(() => '?').join(', ')
	const result = await db
		.prepare(
			`SELECT id, user_id, title, description, keywords, source_code, source_type,
				search_text, created_at, updated_at
			FROM ui_artifacts
			WHERE id = ? AND user_id IN (${placeholders})
			LIMIT 1`,
		)
		.bind(artifactId, ...ownerIds)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapRow(result)
}

export async function deleteUiArtifact(
	db: D1Database,
	userId: string,
	artifactId: string,
): Promise<boolean> {
	const out = await db
		.prepare(`DELETE FROM ui_artifacts WHERE id = ? AND user_id = ?`)
		.bind(artifactId, userId)
		.run()
	return (out.meta.changes ?? 0) > 0
}

export async function listUiArtifactsByUserId(
	db: D1Database,
	userId: string,
): Promise<Array<UiArtifactRow>> {
	const { results } = await db
		.prepare(
			`SELECT id, user_id, title, description, keywords, source_code, source_type,
				search_text, created_at, updated_at
			FROM ui_artifacts WHERE user_id = ?`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

function mapRow(row: Record<string, unknown>): UiArtifactRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']),
		title: String(row['title']),
		description: String(row['description']),
		keywords: String(row['keywords']),
		code: String(row['source_code']),
		runtime: String(row['source_type']) as UiArtifactRow['runtime'],
		search_text: row['search_text'] == null ? null : String(row['search_text']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}
