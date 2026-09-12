import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntitySource: vi.fn(),
	loadPublishedEntityManifest: vi.fn(async (input: { sourceId: string }) => ({
		content: JSON.stringify({
			name: `@kentcdodds/${input.sourceId}`,
			exports: { '.': './index.js' },
			kody: {
				id: input.sourceId,
				description: 'Batched source fixture',
			},
		}),
	})),
}))

const {
	loadPackageManifestBySourceId,
	loadPackageSourceRowForUser,
	loadPackageSourceRowsForUser,
} = await import('./source.ts')

function createEntitySourcesTable(sqlite: DatabaseSync) {
	sqlite.exec(`
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			published_commit TEXT,
			indexed_commit TEXT,
			manifest_path TEXT NOT NULL,
			source_root TEXT NOT NULL,
			last_external_check_at TEXT,
			external_check_until TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`)
}

function insertSource(
	sqlite: DatabaseSync,
	input: { id: string; userId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO entity_sources VALUES
				(?, ?, 'package', ?, ?, 'commit-1', NULL,
				'package.json', '/', NULL, NULL,
				'2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')`,
		)
		.run(input.id, input.userId, `package-${input.id}`, `repo-${input.id}`)
}

function createLoadEnv(db: D1Database) {
	return {
		env: {
			APP_DB: db,
			BUNDLE_ARTIFACTS_KV: {
				get: vi.fn(async () => null),
				put: vi.fn(async () => undefined),
				delete: vi.fn(async () => undefined),
			} as unknown as KVNamespace,
		} as Env,
		baseUrl: 'https://heykody.dev',
	}
}

test('queue-style concurrent manifest loads issue one entity_sources IN query', async () => {
	const sqlite = new DatabaseSync(':memory:')
	createEntitySourcesTable(sqlite)
	insertSource(sqlite, { id: 'source-a', userId: 'user-1' })
	insertSource(sqlite, { id: 'source-b', userId: 'user-1' })
	insertSource(sqlite, { id: 'source-c', userId: 'user-1' })
	insertSource(sqlite, { id: 'source-other', userId: 'user-2' })

	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries })
	const loadEnv = createLoadEnv(db)

	const [first, second, third] = await Promise.all([
		loadPackageManifestBySourceId({
			...loadEnv,
			userId: 'user-1',
			sourceId: 'source-a',
		}),
		loadPackageManifestBySourceId({
			...loadEnv,
			userId: 'user-1',
			sourceId: 'source-b',
		}),
		loadPackageManifestBySourceId({
			...loadEnv,
			userId: 'user-1',
			sourceId: 'source-c',
		}),
	])

	expect([first.source.id, second.source.id, third.source.id]).toEqual([
		'source-a',
		'source-b',
		'source-c',
	])
	expect(first.manifest.kody.id).toBe('source-a')
	const sourceQueries = queries.filter((query) =>
		query.includes('FROM entity_sources'),
	)
	expect(sourceQueries).toEqual([
		'SELECT * FROM entity_sources WHERE id IN (?, ?, ?)',
	])

	await expect(
		loadPackageSourceRowForUser({
			env: loadEnv.env,
			userId: 'user-1',
			sourceId: 'source-other',
		}),
	).rejects.toThrow('was not found')
	await expect(
		loadPackageSourceRowForUser({
			env: loadEnv.env,
			userId: 'user-1',
			sourceId: 'source-missing',
		}),
	).rejects.toThrow('was not found')

	const loneQueriesStart = queries.length
	const lone = await loadPackageSourceRowForUser({
		env: loadEnv.env,
		userId: 'user-1',
		sourceId: 'source-a',
	})
	expect(lone.id).toBe('source-a')
	expect(queries.slice(loneQueriesStart)).toEqual([
		'SELECT * FROM entity_sources WHERE id = ?',
	])

	const explicit = await loadPackageSourceRowsForUser({
		env: loadEnv.env,
		userId: 'user-1',
		sourceIds: ['source-a', 'source-c', 'source-other', 'source-a', 'missing'],
	})
	expect([...explicit.keys()].sort()).toEqual(['source-a', 'source-c'])
	expect(
		queries.filter((query) => query.includes('WHERE id IN (')).at(-1),
	).toBe('SELECT * FROM entity_sources WHERE id IN (?, ?, ?, ?)')
})
