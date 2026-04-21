export type PublishedBundleArtifactRecord = {
	id: string
	userId: string
	sourceId: string
	publishedCommit: string
	artifactKind: string
	artifactName: string | null
	entryPoint: string
	kvKey: string
	dependenciesJson: string
	createdAt: string
	updatedAt: string
}

export type PublishedBundleArtifactUpsertInput = {
	userId: string
	sourceId: string
	publishedCommit: string
	artifactKind: string
	artifactName: string | null
	entryPoint: string
	kvKey: string
	dependenciesJson: string
}

function mapRow(row: Record<string, unknown>): PublishedBundleArtifactRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		sourceId: String(row['source_id']),
		publishedCommit: String(row['published_commit']),
		artifactKind: String(row['artifact_kind']),
		artifactName:
			row['artifact_name'] == null ? null : String(row['artifact_name']),
		entryPoint: String(row['entry_point']),
		kvKey: String(row['kv_key']),
		dependenciesJson: String(row['dependencies_json'] ?? '[]'),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

export async function getPublishedBundleArtifactByIdentity(
	db: D1Database,
	input: {
		userId: string
		sourceId: string
		artifactKind: string
		artifactName: string | null
		entryPoint: string
	},
) {
	const row = await db
		.prepare(
			`SELECT * FROM published_bundle_artifacts
			WHERE user_id = ? AND source_id = ? AND artifact_kind = ?
				AND COALESCE(artifact_name, '') = COALESCE(?, '')
				AND entry_point = ?
			LIMIT 1`,
		)
		.bind(
			input.userId,
			input.sourceId,
			input.artifactKind,
			input.artifactName,
			input.entryPoint,
		)
		.first<Record<string, unknown>>()
	return row ? mapRow(row) : null
}

export async function listPublishedBundleArtifactsBySourceId(
	db: D1Database,
	sourceId: string,
) {
	const result = await db
		.prepare(
			`SELECT * FROM published_bundle_artifacts
			WHERE source_id = ?
			ORDER BY updated_at DESC, created_at DESC`,
		)
		.bind(sourceId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapRow)
}

export async function insertPublishedBundleArtifactRow(
	db: D1Database,
	input: PublishedBundleArtifactUpsertInput,
) {
	const now = new Date().toISOString()
	const id = crypto.randomUUID()
	await db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name,
				entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			input.userId,
			input.sourceId,
			input.publishedCommit,
			input.artifactKind,
			input.artifactName,
			input.entryPoint,
			input.kvKey,
			input.dependenciesJson,
			now,
			now,
		)
		.run()
	return id
}

export async function updatePublishedBundleArtifactRow(
	db: D1Database,
	input: { id: string } & PublishedBundleArtifactUpsertInput,
) {
	const result = await db
		.prepare(
			`UPDATE published_bundle_artifacts
			SET user_id = ?, source_id = ?, published_commit = ?, artifact_kind = ?,
				artifact_name = ?, entry_point = ?, kv_key = ?, dependencies_json = ?,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(
			input.userId,
			input.sourceId,
			input.publishedCommit,
			input.artifactKind,
			input.artifactName,
			input.entryPoint,
			input.kvKey,
			input.dependenciesJson,
			new Date().toISOString(),
			input.id,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deletePublishedBundleArtifactRowsBySourceId(
	db: D1Database,
	sourceId: string,
) {
	const result = await db
		.prepare(`DELETE FROM published_bundle_artifacts WHERE source_id = ?`)
		.bind(sourceId)
		.run()
	return (result.meta.changes ?? 0) > 0
}
