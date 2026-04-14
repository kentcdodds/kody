import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

async function readMigration(name: string) {
	return await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
}

test('0020 jobs migration rewrites legacy rows into the final codemode-first shape', async () => {
	const db = new DatabaseSync(':memory:')
	db.exec(await readMigration('0018-jobs.sql'))
	db.exec(await readMigration('0019-jobs-constraints.sql'))

	const insertJob = db.prepare(`
		INSERT INTO jobs (
			id, user_id, name, kind, code, server_code, server_code_id,
			method_name, params_json, schedule_json, timezone, enabled,
			kill_switch_enabled, caller_context_json, created_at, updated_at,
			last_run_at, last_run_status, last_run_error, last_duration_ms,
			next_run_at, run_count, success_count, error_count, run_history_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)

	insertJob.run(
		'codemode-job',
		'user-1',
		'Codemode job',
		'codemode',
		'async () => ({ ok: true })',
		null,
		null,
		null,
		JSON.stringify({ step: 'deploy' }),
		JSON.stringify({ type: 'interval', every: '15m' }),
		'UTC',
		1,
		0,
		'{"user":{"userId":"user-1"}}',
		'2026-04-16T00:00:00.000Z',
		'2026-04-16T00:00:00.000Z',
		null,
		null,
		null,
		null,
		'2026-04-16T00:15:00.000Z',
		0,
		0,
		0,
		'[]',
	)
	insertJob.run(
		'facet-job',
		'user-1',
		'Facet job',
		'facet',
		null,
		'export class Job {}',
		'facet-code-1',
		null,
		JSON.stringify({ step: 'sync' }),
		JSON.stringify({ type: 'once', runAt: '2026-04-17T15:00:00.000Z' }),
		'UTC',
		0,
		1,
		'{"user":{"userId":"user-1"}}',
		'2026-04-16T00:00:00.000Z',
		'2026-04-16T01:00:00.000Z',
		'2026-04-16T01:00:00.000Z',
		'success',
		null,
		42,
		'2026-04-17T15:00:00.000Z',
		3,
		3,
		0,
		'[{"startedAt":"2026-04-16T01:00:00.000Z","finishedAt":"2026-04-16T01:00:42.000Z","status":"success","durationMs":42}]',
	)

	db.exec(await readMigration('0020-jobs-codemode-only.sql'))

	const columns = db
		.prepare(`SELECT name FROM pragma_table_info('jobs') ORDER BY cid ASC`)
		.all() as Array<{ name: string }>
	expect(columns.map((column) => column.name)).not.toContain('kind')

	const rows = db
		.prepare(
			`SELECT
				id,
				code,
				server_code,
				server_code_id,
				method_name,
				params_json,
				enabled,
				kill_switch_enabled,
				last_run_status,
				last_duration_ms,
				run_count,
				success_count,
				error_count,
				run_history_json
			FROM jobs
			ORDER BY id ASC`,
		)
		.all() as Array<Record<string, unknown>>

	expect(rows).toEqual([
		{
			id: 'codemode-job',
			code: 'async () => ({ ok: true })',
			server_code: null,
			server_code_id: null,
			method_name: null,
			params_json: '{"step":"deploy"}',
			enabled: 1,
			kill_switch_enabled: 0,
			last_run_status: null,
			last_duration_ms: null,
			run_count: 0,
			success_count: 0,
			error_count: 0,
			run_history_json: '[]',
		},
		{
			id: 'facet-job',
			code: "async (params) => await job.call('run', params)",
			server_code: 'export class Job {}',
			server_code_id: 'facet-code-1',
			method_name: 'run',
			params_json: '{"step":"sync"}',
			enabled: 0,
			kill_switch_enabled: 1,
			last_run_status: 'success',
			last_duration_ms: 42,
			run_count: 3,
			success_count: 3,
			error_count: 0,
			run_history_json:
				'[{"startedAt":"2026-04-16T01:00:00.000Z","finishedAt":"2026-04-16T01:00:42.000Z","status":"success","durationMs":42}]',
		},
	])
})
