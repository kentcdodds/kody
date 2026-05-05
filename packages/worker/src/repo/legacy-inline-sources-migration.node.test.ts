import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

async function readMigration(name: string) {
	return await readFile(
		new URL(`../../migrations/${name}`, import.meta.url),
		'utf8',
	)
}

async function applyMigrations(db: DatabaseSync, names: Array<string>) {
	for (const name of names) {
		db.exec(await readMigration(name))
	}
}

function listColumns(db: DatabaseSync, tableName: string) {
	return (
		db
			.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid ASC`)
			.all(tableName) as Array<{ name: string }>
	).map((column) => column.name)
}

test('final inline-source cleanup keeps D1 projections without legacy source storage', async () => {
	const db = new DatabaseSync(':memory:')
	await applyMigrations(db, [
		'0004-mcp-skills.sql',
		'0005-skill-parameters.sql',
		'0006-ui-artifacts.sql',
		'0009-ui-artifact-parameters.sql',
		'0011-remove-ui-artifacts-search-columns.sql',
		'0012-skill-collections.sql',
		'0013-ui-artifact-search-visibility.sql',
		'0014-skill-names.sql',
		'0017-saved-app-facets.sql',
		'0018-jobs.sql',
		'0019-jobs-constraints.sql',
		'0020-jobs-codemode-only.sql',
		'0021-jobs-storage-id.sql',
		'0023-entity-sources.sql',
		'0024-repo-sessions-and-source-columns.sql',
		'0025-jobs-repo-check-policy.sql',
	])

	db.prepare(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		'source-skill-1',
		'user-1',
		'skill',
		'skill-1',
		'skill-skill-1',
		'commit-skill-1',
		'commit-skill-1',
		'kody.json',
		'/',
		'2026-05-05T00:00:00.000Z',
		'2026-05-05T00:00:00.000Z',
	)
	db.prepare(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		'source-app-1',
		'user-1',
		'app',
		'app-1',
		'app-app-1',
		'commit-app-1',
		'commit-app-1',
		'kody.json',
		'/',
		'2026-05-05T00:00:00.000Z',
		'2026-05-05T00:00:00.000Z',
	)
	db.prepare(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		'source-job-1',
		'user-1',
		'job',
		'job-1',
		'job-job-1',
		'commit-job-1',
		'commit-job-1',
		'kody.json',
		'/',
		'2026-05-05T00:00:00.000Z',
		'2026-05-05T00:00:00.000Z',
	)

	db.prepare(
		`INSERT INTO mcp_skills (
			id, user_id, title, description, keywords, code, search_text,
			uses_capabilities, inferred_capabilities, inference_partial, read_only,
			idempotent, destructive, created_at, updated_at, parameters,
			collection_name, collection_slug, name, source_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		'skill-1',
		'user-1',
		'Repo Skill',
		'Uses repo-backed source.',
		'["repo"]',
		'async () => ({ stale: "d1" })',
		'Repo Skill Uses repo-backed source.',
		'[]',
		'[]',
		0,
		1,
		1,
		0,
		'2026-05-05T00:00:00.000Z',
		'2026-05-05T01:00:00.000Z',
		'[{"name":"owner","type":"string","required":true}]',
		'Repo',
		'repo',
		'repo-skill',
		'source-skill-1',
	)
	db.prepare(
		`INSERT INTO ui_artifacts (
			id, user_id, title, description, client_code, server_code,
			server_code_id, parameters, hidden, created_at, updated_at, source_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		'app-1',
		'user-1',
		'Repo App',
		'Loads from published repo source.',
		'<main>stale d1 html</main>',
		'export default { async fetch() {} }',
		'legacy-server-code-id',
		'{"theme":"dark"}',
		0,
		'2026-05-05T00:00:00.000Z',
		'2026-05-05T01:00:00.000Z',
		'source-app-1',
	)
	db.prepare(
		`INSERT INTO jobs (
			id, user_id, name, code, storage_id, params_json, schedule_json,
			timezone, enabled, kill_switch_enabled, caller_context_json, created_at,
			updated_at, last_run_at, last_run_status, last_run_error,
			last_duration_ms, next_run_at, run_count, success_count, error_count,
			run_history_json, source_id, published_commit, repo_check_policy_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		'job-1',
		'user-1',
		'Repo Job',
		'export default async () => ({ stale: "d1" })',
		'job:job-1',
		'{"dryRun":true}',
		'{"type":"interval","every":"15m"}',
		'UTC',
		1,
		0,
		'{"user":{"userId":"user-1"}}',
		'2026-05-05T00:00:00.000Z',
		'2026-05-05T01:00:00.000Z',
		null,
		null,
		null,
		null,
		'2026-05-05T01:15:00.000Z',
		0,
		0,
		0,
		'[]',
		'source-job-1',
		'commit-job-1',
		'{"allowTypecheckFailures":true}',
	)

	await applyMigrations(db, [
		'0026-drop-legacy-inline-sources.sql',
		'0033-drop-legacy-inline-sources-archive.sql',
	])

	expect(listColumns(db, 'mcp_skills')).not.toContain('code')
	expect(listColumns(db, 'ui_artifacts')).not.toEqual(
		expect.arrayContaining(['client_code', 'server_code', 'server_code_id']),
	)
	expect(listColumns(db, 'jobs')).not.toContain('code')

	expect(() =>
		db.prepare('SELECT COUNT(*) AS count FROM legacy_inline_sources_archive').get(),
	).toThrow(/no such table: legacy_inline_sources_archive/)

	expect(
		db
			.prepare(
				`SELECT id, source_id, title, description, parameters
				FROM mcp_skills`,
			)
			.get(),
	).toEqual({
		id: 'skill-1',
		source_id: 'source-skill-1',
		title: 'Repo Skill',
		description: 'Uses repo-backed source.',
		parameters: '[{"name":"owner","type":"string","required":true}]',
	})
	expect(
		db
			.prepare(
				`SELECT id, source_id, title, description, has_server_code, parameters, hidden
				FROM ui_artifacts`,
			)
			.get(),
	).toEqual({
		id: 'app-1',
		source_id: 'source-app-1',
		title: 'Repo App',
		description: 'Loads from published repo source.',
		has_server_code: 1,
		parameters: '{"theme":"dark"}',
		hidden: 0,
	})
	expect(
		db
			.prepare(
				`SELECT id, source_id, published_commit, storage_id, params_json,
					schedule_json, repo_check_policy_json
				FROM jobs`,
			)
			.get(),
	).toEqual({
		id: 'job-1',
		source_id: 'source-job-1',
		published_commit: 'commit-job-1',
		storage_id: 'job:job-1',
		params_json: '{"dryRun":true}',
		schedule_json: '{"type":"interval","every":"15m"}',
		repo_check_policy_json: '{"allowTypecheckFailures":true}',
	})
})
