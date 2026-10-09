import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	countStaticDependentBundleArtifactPackages,
	getPublishedBundleArtifactByIdentity,
	insertPublishedBundleArtifactRow,
	isPublishedBundleArtifactIdentityConflict,
	listStaticDependentBundleArtifactRows,
	upsertPublishedBundleArtifactRow,
} from './published-bundle-artifacts-repo.ts'

function createPublishedBundleArtifactsDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE published_bundle_artifacts (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT NOT NULL,
			artifact_kind TEXT NOT NULL,
			artifact_name TEXT,
			entry_point TEXT NOT NULL,
			kv_key TEXT NOT NULL,
			dependencies_json TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX idx_published_bundle_artifacts_source_identity
		ON published_bundle_artifacts(
			user_id,
			source_id,
			artifact_kind,
			COALESCE(artifact_name, ''),
			entry_point
		);
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			published_commit TEXT,
			deleted_at TEXT
		);
	`)
	return createD1FromSqlite(sqlite)
}

async function setLivePublishedCommit(
	db: D1Database,
	input: { userId: string; sourceId: string; publishedCommit: string },
) {
	await db
		.prepare(
			`INSERT OR REPLACE INTO entity_sources (id, user_id, published_commit)
			VALUES (?, ?, ?)`,
		)
		.bind(input.sourceId, input.userId, input.publishedCommit)
		.run()
}

function createStaticDependentsDb(input: {
	first?: Record<string, unknown> | null
	results?: Array<Record<string, unknown>>
	onBind?: (query: string, values: Array<unknown>) => void
}) {
	return {
		prepare(query: string) {
			return {
				bind(...values: Array<unknown>) {
					input.onBind?.(query, values)
					return {
						async first() {
							return input.first ?? null
						},
						async all() {
							return { results: input.results ?? [] }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('static dependent bundle artifact queries count and list bounded rows by source id', async () => {
	const onBind = vi.fn()
	const db = createStaticDependentsDb({
		first: {
			total_packages: 2,
			stale_packages: 1,
		},
		results: [
			{
				package_id: 'package-b',
				package_kody_id: 'package-b',
				package_name: '@kentcdodds/package-b',
				source_id: 'source-b',
				published_commit: 'commit-b',
				artifact_kind: 'module',
				artifact_name: '.',
				entry_point: 'src/index.ts',
				package_stale: 1,
				matching_artifact_count: 1,
				matching_entrypoint_count: 1,
				package_bundled_dependency_commit: 'commit-a-old',
				bundled_dependency_commit: 'commit-a-old',
			},
		],
		onBind,
	})
	const queryInput = {
		userId: 'user-1',
		sourceId: 'source-a',
		currentDependencyCommit: 'commit-a-new',
	}

	const counts = await countStaticDependentBundleArtifactPackages(
		db,
		queryInput,
	)
	expect(counts).toEqual({
		totalPackages: 2,
		stalePackages: 1,
	})

	const rows = await listStaticDependentBundleArtifactRows(db, {
		...queryInput,
		packageLimit: 10,
		artifactsPerPackageLimit: 5,
	})
	expect(rows).toEqual([
		{
			packageId: 'package-b',
			packageKodyId: 'package-b',
			packageName: '@kentcdodds/package-b',
			sourceId: 'source-b',
			publishedCommit: 'commit-b',
			artifactKind: 'module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			packageStale: true,
			matchingArtifactCount: 1,
			matchingEntrypointCount: 1,
			packageBundledDependencyCommit: 'commit-a-old',
			bundledDependencyCommit: 'commit-a-old',
		},
	])

	expect(onBind).toHaveBeenCalledTimes(2)
	expect(onBind).toHaveBeenNthCalledWith(1, expect.any(String), [
		'commit-a-new',
		'user-1',
		'source-a',
		'source-a',
	])
	expect(onBind).toHaveBeenNthCalledWith(2, expect.any(String), [
		'commit-a-new',
		'user-1',
		'source-a',
		'source-a',
		10,
		5,
	])
})

const identity = {
	userId: 'user-1',
	sourceId: 'source-1',
	artifactName: './record-version',
	entryPoint: 'src/record-version.ts',
}

function artifactRow(
	artifactKind: 'module' | 'importable-module',
	publishedCommit: string,
	dependenciesJson = '[]',
) {
	const kvPrefix = artifactKind === 'module' ? 'module' : 'importable'
	return {
		...identity,
		publishedCommit,
		artifactKind,
		kvKey: `kv:${kvPrefix}:${publishedCommit}`,
		dependenciesJson,
	}
}

function lookup(db: D1Database, artifactKind: string) {
	return getPublishedBundleArtifactByIdentity(db, { ...identity, artifactKind })
}

test('upsertPublishedBundleArtifactRow keeps module and importable-module distinct and recovers a raced identity insert', async () => {
	const db = createPublishedBundleArtifactsDb()
	await upsertPublishedBundleArtifactRow(db, artifactRow('module', 'commit-1'))
	const importableId = await upsertPublishedBundleArtifactRow(
		db,
		artifactRow('importable-module', 'commit-1'),
	)
	await expect(lookup(db, 'importable-module')).resolves.toEqual(
		expect.objectContaining({
			id: importableId,
			publishedCommit: 'commit-1',
			artifactKind: 'importable-module',
			kvKey: 'kv:importable:commit-1',
		}),
	)

	const commit2 = artifactRow(
		'importable-module',
		'commit-2',
		'[{"sourceId":"dep-1"}]',
	)
	await expect(insertPublishedBundleArtifactRow(db, commit2)).rejects.toSatisfy(
		isPublishedBundleArtifactIdentityConflict,
	)

	await expect(upsertPublishedBundleArtifactRow(db, commit2)).resolves.toBe(
		importableId,
	)
	await expect(lookup(db, 'importable-module')).resolves.toEqual(
		expect.objectContaining({
			id: importableId,
			publishedCommit: 'commit-2',
			kvKey: 'kv:importable:commit-2',
			dependenciesJson: '[{"sourceId":"dep-1"}]',
		}),
	)
	await expect(lookup(db, 'module')).resolves.toEqual(
		expect.objectContaining({
			publishedCommit: 'commit-1',
			artifactKind: 'module',
			kvKey: 'kv:module:commit-1',
		}),
	)
})

test('upsertPublishedBundleArtifactRow recovers when lookup misses and insert hits the identity unique index', async () => {
	const existingRow = {
		id: 'row-importable',
		user_id: 'user-1',
		source_id: 'source-1',
		published_commit: 'commit-1',
		artifact_kind: 'importable-module',
		artifact_name: './record-version',
		entry_point: 'src/record-version.ts',
		kv_key: 'kv:importable:commit-1',
		dependencies_json: '[]',
		created_at: '2026-09-14T00:00:00.000Z',
		updated_at: '2026-09-14T00:00:00.000Z',
	}
	let lookups = 0
	let updatedValues: Array<unknown> | null = null
	const db = {
		prepare(query: string) {
			return {
				bind(...values: Array<unknown>) {
					return {
						async first() {
							if (query.includes('FROM entity_sources')) {
								return { published_commit: 'commit-2' }
							}
							lookups += 1
							return lookups === 1 ? null : existingRow
						},
						async run() {
							if (query.includes('INSERT INTO published_bundle_artifacts')) {
								throw new Error(
									'D1_ERROR: UNIQUE constraint failed: idx_published_bundle_artifacts_source_identity: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
								)
							}
							updatedValues = values.slice(0, 8)
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	await expect(
		upsertPublishedBundleArtifactRow(
			db,
			artifactRow('importable-module', 'commit-2', '[{"sourceId":"dep-1"}]'),
		),
	).resolves.toBe('row-importable')
	expect(lookups).toBe(2)
	expect(updatedValues).toEqual([
		'user-1',
		'source-1',
		'commit-2',
		'importable-module',
		'./record-version',
		'src/record-version.ts',
		'kv:importable:commit-2',
		'[{"sourceId":"dep-1"}]',
	])
})

test('upsertPublishedBundleArtifactRow leaves a newer live identity alone when a stale persist recovers', async () => {
	const db = createPublishedBundleArtifactsDb()
	await setLivePublishedCommit(db, {
		userId: 'user-1',
		sourceId: 'source-1',
		publishedCommit: 'commit-2',
	})
	const liveId = await upsertPublishedBundleArtifactRow(
		db,
		artifactRow('importable-module', 'commit-2'),
	)
	await expect(
		upsertPublishedBundleArtifactRow(
			db,
			artifactRow('importable-module', 'commit-1'),
		),
	).resolves.toBe(liveId)
	await expect(lookup(db, 'importable-module')).resolves.toEqual(
		expect.objectContaining({
			id: liveId,
			publishedCommit: 'commit-2',
			kvKey: 'kv:importable:commit-2',
		}),
	)
})
