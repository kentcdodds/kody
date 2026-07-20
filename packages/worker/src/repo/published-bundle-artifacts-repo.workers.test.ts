import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { getStaticPackageDependentsSummary } from '#worker/package-runtime/static-package-dependents.ts'

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensurePublishedBundleArtifactDependencySchema() {
	await runSql(`CREATE TABLE IF NOT EXISTS entity_sources (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		entity_kind TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		repo_id TEXT NOT NULL,
		published_commit TEXT,
		indexed_commit TEXT,
		manifest_path TEXT NOT NULL DEFAULT 'package.json',
		source_root TEXT NOT NULL DEFAULT '/',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS saved_packages (
		id TEXT PRIMARY KEY NOT NULL,
		user_id TEXT NOT NULL,
		name TEXT NOT NULL,
		kody_id TEXT NOT NULL,
		description TEXT NOT NULL,
		tags_json TEXT NOT NULL DEFAULT '[]',
		search_text TEXT,
		source_id TEXT NOT NULL,
		has_app INTEGER NOT NULL DEFAULT 0 CHECK (has_app IN (0, 1)),
		hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
		is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1)),
		created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
		updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
	)`)
	try {
		await runSql(
			`ALTER TABLE saved_packages ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1`,
		)
	} catch {
		// Column already present on newer schemas.
	}
	await runSql(`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
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
	)`)
}

async function insertPackage(input: {
	userId: string
	packageId: string
	kodyId: string
	name: string
	sourceId: string
	publishedCommit: string
}) {
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		input.packageId,
		input.userId,
		input.name,
		input.kodyId,
		`${input.name} package`,
		input.sourceId,
		now,
		now,
	)
	await runSql(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
		input.sourceId,
		input.userId,
		input.packageId,
		`repo-${input.sourceId}`,
		input.publishedCommit,
		now,
		now,
	)
}

async function insertArtifact(input: {
	userId: string
	sourceId: string
	publishedCommit: string
	artifactName: string
	entryPoint: string
	dependencies: Array<Record<string, unknown>>
}) {
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO published_bundle_artifacts (
			id, user_id, source_id, published_commit, artifact_kind, artifact_name,
			entry_point, kv_key, dependencies_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, 'module', ?, ?, ?, ?, ?, ?)`,
		crypto.randomUUID(),
		input.userId,
		input.sourceId,
		input.publishedCommit,
		input.artifactName,
		input.entryPoint,
		`kv:${input.sourceId}:${input.artifactName}`,
		JSON.stringify(input.dependencies),
		now,
		now,
	)
}

test('static dependent summary runs JSON dependency queries against D1', async () => {
	await ensurePublishedBundleArtifactDependencySchema()
	const unique = crypto.randomUUID()
	const userId = `user-${unique}`
	const sourceA = `source-a-${unique}`
	const sourceB = `source-b-${unique}`
	const sourceC = `source-c-${unique}`
	const sourceD = `source-d-${unique}`
	await insertPackage({
		userId,
		packageId: `package-a-${unique}`,
		kodyId: `package-a-${unique}`,
		name: `@kentcdodds/package-a-${unique}`,
		sourceId: sourceA,
		publishedCommit: 'commit-a-new',
	})
	await insertPackage({
		userId,
		packageId: `package-b-${unique}`,
		kodyId: `package-b-${unique}`,
		name: `@kentcdodds/package-b-${unique}`,
		sourceId: sourceB,
		publishedCommit: 'commit-b',
	})
	await insertPackage({
		userId,
		packageId: `package-c-${unique}`,
		kodyId: `package-c-${unique}`,
		name: `@kentcdodds/package-c-${unique}`,
		sourceId: sourceC,
		publishedCommit: 'commit-c',
	})
	await insertPackage({
		userId,
		packageId: `package-d-${unique}`,
		kodyId: `package-d-${unique}`,
		name: `@kentcdodds/package-d-${unique}`,
		sourceId: sourceD,
		publishedCommit: 'commit-d-current',
	})
	for (let index = 0; index < 5; index += 1) {
		await insertArtifact({
			userId,
			sourceId: sourceB,
			publishedCommit: 'commit-b',
			artifactName: `a-current-${index}`,
			entryPoint: `src/current-${index}.ts`,
			dependencies: [
				{
					sourceId: sourceA,
					publishedCommit: 'commit-a-new',
					kodyId: `package-a-${unique}`,
					packageName: `@kentcdodds/package-a-${unique}`,
				},
			],
		})
	}
	await insertArtifact({
		userId,
		sourceId: sourceB,
		publishedCommit: 'commit-b',
		artifactName: 'a-current-0-importable',
		entryPoint: 'src/current-0.ts',
		dependencies: [
			{
				sourceId: sourceA,
				publishedCommit: 'commit-a-new',
				kodyId: `package-a-${unique}`,
				packageName: `@kentcdodds/package-a-${unique}`,
			},
		],
	})
	await insertArtifact({
		userId,
		sourceId: sourceB,
		publishedCommit: 'commit-b',
		artifactName: 'z-stale',
		entryPoint: 'src/stale.ts',
		dependencies: [
			{
				sourceId: sourceA,
				publishedCommit: 'commit-a-old',
				kodyId: `package-a-${unique}`,
				packageName: `@kentcdodds/package-a-${unique}`,
			},
		],
	})
	await insertArtifact({
		userId,
		sourceId: sourceC,
		publishedCommit: 'commit-c',
		artifactName: 'missing-commit',
		entryPoint: 'src/missing.ts',
		dependencies: [
			{
				sourceId: sourceA,
				kodyId: `package-a-${unique}`,
				packageName: `@kentcdodds/package-a-${unique}`,
			},
		],
	})
	await insertArtifact({
		userId,
		sourceId: sourceD,
		publishedCommit: 'commit-d-obsolete',
		artifactName: 'removed-import',
		entryPoint: 'src/removed-import.ts',
		dependencies: [
			{
				sourceId: sourceA,
				publishedCommit: 'commit-a-old',
				kodyId: `package-a-${unique}`,
				packageName: `@kentcdodds/package-a-${unique}`,
			},
		],
	})

	const summary = await getStaticPackageDependentsSummary({
		db: env.APP_DB,
		userId,
		sourceId: sourceA,
		currentDependencyCommit: 'commit-a-new',
	})

	expect(summary).toEqual(
		expect.objectContaining({
			total: 2,
			stale: 2,
			truncated: false,
		}),
	)
	expect(summary.items[0]).toEqual(
		expect.objectContaining({
			name: `@kentcdodds/package-b-${unique}`,
			stale: true,
			artifact_count: 7,
			entrypoints_truncated: true,
			bundled_dependency_commit: null,
		}),
	)
	expect(summary.items[0]?.entrypoints).toHaveLength(5)
	expect(summary.items[0]?.entrypoints[0]).toBe('src/stale.ts')
	expect(summary.items[1]).toEqual(
		expect.objectContaining({
			name: `@kentcdodds/package-c-${unique}`,
			stale: true,
			bundled_dependency_commit: null,
		}),
	)
})
