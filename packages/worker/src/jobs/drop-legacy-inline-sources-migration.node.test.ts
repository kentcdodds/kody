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

test('0026 archives orphaned inline rows and keeps rows with matching entity sources', async () => {
	const db = new DatabaseSync(':memory:')

	await applyMigrations(db, [
		'0004-mcp-skills.sql',
		'0005-skill-parameters.sql',
		'0012-skill-collections.sql',
		'0014-skill-names.sql',
		'0006-ui-artifacts.sql',
		'0009-ui-artifact-parameters.sql',
		'0011-remove-ui-artifacts-search-columns.sql',
		'0013-ui-artifact-search-visibility.sql',
		'0017-saved-app-facets.sql',
		'0018-jobs.sql',
		'0019-jobs-constraints.sql',
		'0020-jobs-codemode-only.sql',
		'0021-jobs-storage-id.sql',
		'0023-entity-sources.sql',
		'0024-repo-sessions-and-source-columns.sql',
		'0025-jobs-repo-check-policy.sql',
	])

	db.exec(`
		INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit, indexed_commit,
			manifest_path, source_root, created_at, updated_at
		) VALUES
			('source-skill-keep', 'user-1', 'skill', 'skill-keep', 'skill-skill-keep', 'commit-skill', 'commit-skill', 'kody.json', '/', '2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z'),
			('source-app-keep', 'user-1', 'app', 'app-keep', 'app-app-keep', 'commit-app', 'commit-app', 'kody.json', '/', '2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z'),
			('source-job-keep', 'user-1', 'job', 'job-keep', 'job-job-keep', 'commit-job', 'commit-job', 'kody.json', '/', '2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z');

		INSERT INTO mcp_skills (
			id, user_id, title, description, keywords, code, search_text,
			uses_capabilities, inferred_capabilities, inference_partial, read_only,
			idempotent, destructive, created_at, updated_at, parameters,
			collection_name, collection_slug, name, source_id
		) VALUES
			(
				'skill-keep', 'user-1', 'Keep skill', 'Repo metadata exists', 'keep',
				'export default async () => "keep"', 'keep', null, '[]', 0, 0, 1, 0,
				'2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z', null, null,
				null, 'keep-skill', null
			),
			(
				'skill-archive', 'user-1', 'Archive skill', 'No repo metadata', 'archive',
				'export default async () => "archive"', 'archive', null, '[]', 0, 1, 0, 0,
				'2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z', null, null,
				null, 'archive-skill', null
			);

		INSERT INTO ui_artifacts (
			id, user_id, title, description, client_code, server_code, server_code_id,
			parameters, hidden, created_at, updated_at, source_id
		) VALUES
			(
				'app-keep', 'user-1', 'Keep app', 'Repo metadata exists',
				'<main>keep</main>', 'export class App extends DurableObject {}',
				'server-keep', null, 0, '2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z', null
			),
			(
				'app-archive', 'user-1', 'Archive app', 'No repo metadata',
				'<main>archive</main>', null, 'server-archive', null, 1,
				'2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z', null
			);

		INSERT INTO jobs (
			id, user_id, name, code, storage_id, params_json, schedule_json, timezone,
			enabled, kill_switch_enabled, caller_context_json, created_at, updated_at,
			last_run_at, last_run_status, last_run_error, last_duration_ms,
			next_run_at, run_count, success_count, error_count, run_history_json,
			source_id, published_commit, repo_check_policy_json
		) VALUES
			(
				'job-keep', 'user-1', 'Keep job', 'export default async () => ({ ok: true })',
				'job:job-keep', '{"step":"keep"}', '{"type":"once","runAt":"2026-04-19T00:00:00.000Z"}',
				'UTC', 1, 0, '{"user":{"userId":"user-1"}}',
				'2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z',
				null, null, null, null, '2026-04-19T00:00:00.000Z', 0, 0, 0, '[]', null, null, null
			),
			(
				'job-archive', 'user-1', 'Archive job', 'export default async () => ({ ok: false })',
				'job:job-archive', '{"step":"archive"}', '{"type":"once","runAt":"2026-04-20T00:00:00.000Z"}',
				'UTC', 0, 1, '{"user":{"userId":"user-1"}}',
				'2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z',
				null, null, null, null, '2026-04-20T00:00:00.000Z', 2, 1, 1, '[]', null, null, '{"allowTypecheckFailures":true}'
			);
	`)

	db.exec(await readMigration('0026-drop-legacy-inline-sources.sql'))

	const skills = db
		.prepare(`SELECT id, source_id FROM mcp_skills ORDER BY id ASC`)
		.all() as Array<{ id: string; source_id: string }>
	expect(skills).toEqual([{ id: 'skill-keep', source_id: 'source-skill-keep' }])

	const apps = db
		.prepare(`SELECT id, source_id, has_server_code FROM ui_artifacts ORDER BY id ASC`)
		.all() as Array<{ id: string; source_id: string; has_server_code: number }>
	expect(apps).toEqual([
		{ id: 'app-keep', source_id: 'source-app-keep', has_server_code: 1 },
	])

	const jobs = db
		.prepare(`SELECT id, source_id, storage_id FROM jobs ORDER BY id ASC`)
		.all() as Array<{ id: string; source_id: string; storage_id: string }>
	expect(jobs).toEqual([
		{
			id: 'job-keep',
			source_id: 'source-job-keep',
			storage_id: 'job:job-keep',
		},
	])

	const archiveRows = db
		.prepare(
			`SELECT entity_kind, entity_id, display_name, payload_json
			FROM legacy_inline_sources_archive
			ORDER BY entity_kind ASC`,
		)
		.all() as Array<{
			entity_kind: string
			entity_id: string
			display_name: string
			payload_json: string
		}>

	expect(
		archiveRows.map(({ entity_kind, entity_id, display_name }) => ({
			entity_kind,
			entity_id,
			display_name,
		})),
	).toEqual([
		{
			entity_kind: 'app',
			entity_id: 'app-archive',
			display_name: 'Archive app',
		},
		{
			entity_kind: 'job',
			entity_id: 'job-archive',
			display_name: 'Archive job',
		},
		{
			entity_kind: 'skill',
			entity_id: 'skill-archive',
			display_name: 'Archive skill',
		},
	])

	const archivedAppPayload = JSON.parse(
		archiveRows.find((row) => row.entity_kind === 'app')!.payload_json,
	) as {
		client_code: string
	}
	expect(archivedAppPayload.client_code).toBe('<main>archive</main>')

	const archivedSkillPayload = JSON.parse(
		archiveRows.find((row) => row.entity_kind === 'skill')!.payload_json,
	) as {
		code: string
	}
	expect(archivedSkillPayload.code).toContain('archive')

	const archivedJobPayload = JSON.parse(
		archiveRows.find((row) => row.entity_kind === 'job')!.payload_json,
	) as {
		repo_check_policy_json: string | null
	}
	expect(archivedJobPayload.repo_check_policy_json).toBe(
		'{"allowTypecheckFailures":true}',
	)
})
