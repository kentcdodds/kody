export type ArchivedJobArtifactRecord = {
	id: string
	jobId: string
	userId: string
	sourceId: string
	publishedCommit: string
	storageId: string
	retainUntil: string
	createdAt: string
	updatedAt: string
}

export async function upsertArchivedJobArtifact(input: {
	db: D1Database
	jobId: string
	userId: string
	sourceId: string
	publishedCommit: string
	storageId: string
	retainUntil: string
}) {
	const now = new Date().toISOString()
	const existing = await input.db
		.prepare(
			`SELECT id FROM archived_job_artifacts WHERE job_id = ? AND user_id = ? LIMIT 1`,
		)
		.bind(input.jobId, input.userId)
		.first<{ id: string }>()
	if (existing?.id) {
		await input.db
			.prepare(
				`UPDATE archived_job_artifacts
				SET source_id = ?, published_commit = ?, storage_id = ?, retain_until = ?, updated_at = ?
				WHERE id = ?`,
			)
			.bind(
				input.sourceId,
				input.publishedCommit,
				input.storageId,
				input.retainUntil,
				now,
				existing.id,
			)
			.run()
		return existing.id
	}
	const id = crypto.randomUUID()
	await input.db
		.prepare(
			`INSERT INTO archived_job_artifacts (
				id, job_id, user_id, source_id, published_commit, storage_id, retain_until, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			input.jobId,
			input.userId,
			input.sourceId,
			input.publishedCommit,
			input.storageId,
			input.retainUntil,
			now,
			now,
		)
		.run()
	return id
}

export async function listArchivedJobArtifactsDueBefore(
	db: D1Database,
	retainUntil: string,
	limit = 100,
): Promise<Array<ArchivedJobArtifactRecord>> {
	const { results } = await db
		.prepare(
			`SELECT id, job_id, user_id, source_id, published_commit, storage_id, retain_until, created_at, updated_at
			FROM archived_job_artifacts
			WHERE retain_until <= ?
			ORDER BY retain_until ASC, id ASC
			LIMIT ?`,
		)
		.bind(retainUntil, limit)
		.all<Record<string, unknown>>()
	return (results ?? []).map((row) => ({
		id: String(row['id']),
		jobId: String(row['job_id']),
		userId: String(row['user_id']),
		sourceId: String(row['source_id']),
		publishedCommit: String(row['published_commit']),
		storageId: String(row['storage_id']),
		retainUntil: String(row['retain_until']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}))
}

export async function deleteArchivedJobArtifact(db: D1Database, id: string) {
	await db
		.prepare(`DELETE FROM archived_job_artifacts WHERE id = ?`)
		.bind(id)
		.run()
}

export async function listArchivedJobArtifactsForUser(
	db: D1Database,
	userId: string,
): Promise<Array<ArchivedJobArtifactRecord>> {
	const { results } = await db
		.prepare(
			`SELECT id, job_id, user_id, source_id, published_commit, storage_id, retain_until, created_at, updated_at
			FROM archived_job_artifacts
			WHERE user_id = ?
			ORDER BY id ASC`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map((row) => ({
		id: String(row['id']),
		jobId: String(row['job_id']),
		userId: String(row['user_id']),
		sourceId: String(row['source_id']),
		publishedCommit: String(row['published_commit']),
		storageId: String(row['storage_id']),
		retainUntil: String(row['retain_until']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}))
}

/**
 * Platform-wide (userId, storageId) pairs for every archived artifact.
 * Operator-level DR inventory only — not for user-facing paths.
 */
export async function listAllArchivedJobArtifactStorageOwnerRows(
	db: D1Database,
): Promise<Array<{ userId: string; storageId: string }>> {
	const { results } = await db
		.prepare(
			`SELECT user_id AS userId, storage_id AS storageId
			FROM archived_job_artifacts WHERE storage_id IS NOT NULL`,
		)
		.all<{ userId: string; storageId: string }>()
	return results ?? []
}
