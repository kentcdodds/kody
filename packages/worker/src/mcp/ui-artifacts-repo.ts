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
				id, user_id, title, description, source_code, source_type,
				parameters, hidden, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.title,
			row.description,
			row.code,
			row.runtime,
			row.parameters ?? null,
			row.hidden ? 1 : 0,
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
			`SELECT id, user_id, title, description, source_code, source_type,
				parameters, hidden, created_at, updated_at
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
			`SELECT id, user_id, title, description, source_code, source_type,
				parameters, hidden, created_at, updated_at
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

export async function updateUiArtifact(
	db: D1Database,
	userId: string,
	artifactId: string,
	updates: Partial<
		Pick<
			UiArtifactRow,
			| 'title'
			| 'description'
			| 'code'
			| 'runtime'
			| 'parameters'
			| 'hidden'
		>
	>,
): Promise<boolean> {
	const assignments: Array<string> = []
	const values: Array<unknown> = []
	const addAssignment = (column: string, value: unknown) => {
		assignments.push(`${column} = ?`)
		values.push(value)
	}

	if (updates.title !== undefined) {
		addAssignment('title', updates.title)
	}
	if (updates.description !== undefined) {
		addAssignment('description', updates.description)
	}
	if (updates.code !== undefined) {
		addAssignment('source_code', updates.code)
	}
	if (updates.runtime !== undefined) {
		addAssignment('source_type', updates.runtime)
	}
	if (updates.parameters !== undefined) {
		addAssignment('parameters', updates.parameters ?? null)
	}
	if (updates.hidden !== undefined) {
		addAssignment('hidden', updates.hidden ? 1 : 0)
	}

	addAssignment('updated_at', new Date().toISOString())

	const out = await db
		.prepare(
			`UPDATE ui_artifacts SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`,
		)
		.bind(...values, artifactId, userId)
		.run()
	return (out.meta.changes ?? 0) > 0
}

export async function listUiArtifactsByUserId(
	db: D1Database,
	userId: string,
	options?: { hidden?: boolean },
): Promise<Array<UiArtifactRow>> {
	const hidden = options?.hidden
	const { results } = await db
		.prepare(
			`SELECT id, user_id, title, description, source_code, source_type,
				parameters, hidden, created_at, updated_at
			FROM ui_artifacts
			WHERE user_id = ?
				${hidden === undefined ? '' : 'AND hidden = ?'}`,
		)
		.bind(
			userId,
			...(hidden === undefined ? [] : [hidden ? 1 : 0]),
		)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

function mapRow(row: Record<string, unknown>): UiArtifactRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']),
		title: String(row['title']),
		description: String(row['description']),
		code: String(row['source_code']),
		runtime: String(row['source_type']) as UiArtifactRow['runtime'],
		parameters: row['parameters'] == null ? null : String(row['parameters']),
		hidden:
			row['hidden'] === 1 ||
			row['hidden'] === '1' ||
			row['hidden'] === true,
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}
