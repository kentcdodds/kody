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

export type StaticDependentBundleArtifactRow = {
	packageId: string
	packageKodyId: string
	packageName: string
	sourceId: string
	publishedCommit: string | null
	artifactKind: string
	artifactName: string | null
	entryPoint: string
	packageStale: boolean
	matchingArtifactCount: number
	matchingEntrypointCount: number
	packageBundledDependencyCommit: string | null
	bundledDependencyCommit: string | null
}

export type StaticDependentBundleArtifactCounts = {
	totalPackages: number
	stalePackages: number
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

function mapStaticDependentBundleArtifactRow(
	row: Record<string, unknown>,
): StaticDependentBundleArtifactRow {
	return {
		packageId: String(row['package_id']),
		packageKodyId: String(row['package_kody_id']),
		packageName: String(row['package_name']),
		sourceId: String(row['source_id']),
		publishedCommit:
			row['published_commit'] == null ? null : String(row['published_commit']),
		artifactKind: String(row['artifact_kind']),
		artifactName:
			row['artifact_name'] == null ? null : String(row['artifact_name']),
		entryPoint: String(row['entry_point']),
		packageStale: Number(row['package_stale'] ?? 0) === 1,
		matchingArtifactCount: Number(row['matching_artifact_count'] ?? 0),
		matchingEntrypointCount: Number(row['matching_entrypoint_count'] ?? 0),
		packageBundledDependencyCommit:
			row['package_bundled_dependency_commit'] == null
				? null
				: String(row['package_bundled_dependency_commit']),
		bundledDependencyCommit:
			row['bundled_dependency_commit'] == null
				? null
				: String(row['bundled_dependency_commit']),
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

export async function countStaticDependentBundleArtifactPackages(
	db: D1Database,
	input: {
		userId: string
		sourceId: string
		currentDependencyCommit: string
	},
): Promise<StaticDependentBundleArtifactCounts> {
	const row = await db
		.prepare(
			`WITH matching AS (
				SELECT
					p.id AS package_id,
					CASE
						WHEN json_extract(dependency.value, '$.publishedCommit') IS NULL
							OR json_extract(dependency.value, '$.publishedCommit') != ?
						THEN 1
						ELSE 0
					END AS stale
				FROM published_bundle_artifacts AS artifact
				JOIN json_each(artifact.dependencies_json) AS dependency
				JOIN entity_sources AS source
					ON source.id = artifact.source_id
					AND source.user_id = artifact.user_id
					AND source.entity_kind = 'package'
				JOIN saved_packages AS p
					ON p.id = source.entity_id
					AND p.user_id = artifact.user_id
				WHERE artifact.user_id = ?
					AND artifact.source_id != ?
					AND artifact.published_commit = source.published_commit
					AND json_extract(dependency.value, '$.sourceId') = ?
			)
			SELECT
				COUNT(DISTINCT package_id) AS total_packages,
				COUNT(DISTINCT CASE WHEN stale = 1 THEN package_id END) AS stale_packages
			FROM matching`,
		)
		.bind(
			input.currentDependencyCommit,
			input.userId,
			input.sourceId,
			input.sourceId,
		)
		.first<Record<string, unknown>>()
	return {
		totalPackages: Number(row?.['total_packages'] ?? 0),
		stalePackages: Number(row?.['stale_packages'] ?? 0),
	}
}

export async function listStaticDependentBundleArtifactRows(
	db: D1Database,
	input: {
		userId: string
		sourceId: string
		currentDependencyCommit: string
		packageLimit: number
		artifactsPerPackageLimit: number
	},
) {
	const result = await db
		.prepare(
			`WITH matching AS (
				SELECT
					p.id AS package_id,
					p.kody_id AS package_kody_id,
					p.name AS package_name,
					artifact.source_id,
					source.published_commit,
					artifact.artifact_kind,
					artifact.artifact_name,
					artifact.entry_point,
					json_extract(dependency.value, '$.publishedCommit') AS bundled_dependency_commit,
					CASE
						WHEN json_extract(dependency.value, '$.publishedCommit') IS NULL
							OR json_extract(dependency.value, '$.publishedCommit') != ?
						THEN 1
						ELSE 0
					END AS stale
				FROM published_bundle_artifacts AS artifact
				JOIN json_each(artifact.dependencies_json) AS dependency
				JOIN entity_sources AS source
					ON source.id = artifact.source_id
					AND source.user_id = artifact.user_id
					AND source.entity_kind = 'package'
				JOIN saved_packages AS p
					ON p.id = source.entity_id
					AND p.user_id = artifact.user_id
				WHERE artifact.user_id = ?
					AND artifact.source_id != ?
					AND artifact.published_commit = source.published_commit
					AND json_extract(dependency.value, '$.sourceId') = ?
			),
			package_rollup AS (
				SELECT
					package_id,
					MAX(stale) AS package_stale,
					COUNT(*) AS matching_artifact_count,
					COUNT(DISTINCT entry_point) AS matching_entrypoint_count,
					CASE
						WHEN COUNT(DISTINCT COALESCE(bundled_dependency_commit, '__missing__')) = 1
						THEN MIN(bundled_dependency_commit)
						ELSE NULL
					END AS package_bundled_dependency_commit
				FROM matching
				GROUP BY package_id
			),
			entrypoint_representatives AS (
				SELECT
					matching.*,
					package_rollup.package_stale,
					package_rollup.matching_artifact_count,
					package_rollup.matching_entrypoint_count,
					package_rollup.package_bundled_dependency_commit,
					ROW_NUMBER() OVER (
						PARTITION BY matching.package_id, matching.entry_point
						ORDER BY stale DESC, artifact_kind ASC, COALESCE(artifact_name, '') ASC, entry_point ASC
					) AS entrypoint_artifact_rank
				FROM matching
				JOIN package_rollup
					ON package_rollup.package_id = matching.package_id
			),
			ranked_entrypoints AS (
				SELECT
					entrypoint_representatives.*,
					ROW_NUMBER() OVER (
						PARTITION BY package_id
						ORDER BY stale DESC, entry_point ASC
					) AS entrypoint_rank
				FROM entrypoint_representatives
				WHERE entrypoint_artifact_rank = 1
			),
			ranked_packages AS (
				SELECT
					ranked_entrypoints.*,
					DENSE_RANK() OVER (
						ORDER BY package_stale DESC, package_name ASC, package_id ASC
					) AS package_rank
				FROM ranked_entrypoints
			)
			SELECT
				package_id,
				package_kody_id,
				package_name,
				source_id,
				published_commit,
				artifact_kind,
				artifact_name,
				entry_point,
				package_stale,
				matching_artifact_count,
				matching_entrypoint_count,
				package_bundled_dependency_commit,
				bundled_dependency_commit
			FROM ranked_packages
			WHERE package_rank <= ? AND entrypoint_rank <= ?
			ORDER BY package_rank ASC, entrypoint_rank ASC`,
		)
		.bind(
			input.currentDependencyCommit,
			input.userId,
			input.sourceId,
			input.sourceId,
			input.packageLimit,
			input.artifactsPerPackageLimit,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapStaticDependentBundleArtifactRow)
}

export async function listPublishedBundleArtifactsBySourceId(
	db: D1Database,
	userId: string,
	sourceId: string,
) {
	const result = await db
		.prepare(
			`SELECT * FROM published_bundle_artifacts
			WHERE user_id = ? AND source_id = ?
			ORDER BY updated_at DESC, created_at DESC`,
		)
		.bind(userId, sourceId)
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
	userId: string,
	sourceId: string,
) {
	const result = await db
		.prepare(
			`DELETE FROM published_bundle_artifacts WHERE user_id = ? AND source_id = ?`,
		)
		.bind(userId, sourceId)
		.run()
	return (result.meta.changes ?? 0) > 0
}
