import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { listDueJobRows, maxDueJobsPerAlarm } from './repo.ts'

async function ensureJobsSchema() {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT,
			repo_check_policy_json TEXT,
			storage_id TEXT NOT NULL,
			params_json TEXT,
			schedule_json TEXT NOT NULL,
			timezone TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			kill_switch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch_enabled IN (0, 1)),
			caller_context_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_run_at TEXT,
			last_run_status TEXT,
			last_run_error TEXT,
			last_duration_ms INTEGER,
			next_run_at TEXT NOT NULL,
			run_count INTEGER NOT NULL DEFAULT 0,
			success_count INTEGER NOT NULL DEFAULT 0,
			error_count INTEGER NOT NULL DEFAULT 0,
			run_history_json TEXT NOT NULL DEFAULT '[]'
		)`,
	).run()
	await env.APP_DB.prepare(`DELETE FROM jobs`).run()
}

async function insertJob(input: {
	id: string
	userId: string
	nextRunAt: string
	enabled?: boolean
	killSwitchEnabled?: boolean
}) {
	const now = '2026-04-20T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT INTO jobs (
			id, user_id, name, source_id, storage_id, schedule_json, timezone,
			enabled, kill_switch_enabled, caller_context_json, created_at,
			updated_at, next_run_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'null', ?, ?, ?)`,
	)
		.bind(
			input.id,
			input.userId,
			input.id,
			`source-${input.id}`,
			`job:${input.id}`,
			JSON.stringify({ type: 'once', runAt: input.nextRunAt }),
			'UTC',
			input.enabled === false ? 0 : 1,
			input.killSwitchEnabled === true ? 1 : 0,
			now,
			now,
			input.nextRunAt,
		)
		.run()
}

test('listDueJobRows caps a due-job backlog at maxDueJobsPerAlarm, oldest first', async () => {
	await ensureJobsSchema()
	const userId = 'user-due-limit'
	const nowIso = '2026-04-20T12:00:00.000Z'
	const backlogSize = maxDueJobsPerAlarm + 5
	for (let index = 0; index < backlogSize; index += 1) {
		await insertJob({
			id: `due-${String(index).padStart(3, '0')}`,
			userId,
			nextRunAt: new Date(
				Date.parse('2026-04-20T00:00:00.000Z') + index * 60_000,
			).toISOString(),
		})
	}
	// Rows that must never be picked up: other user, disabled, kill-switched,
	// and not-yet-due jobs.
	await insertJob({
		id: 'other-user',
		userId: 'user-other',
		nextRunAt: '2026-04-20T00:00:00.000Z',
	})
	await insertJob({
		id: 'disabled',
		userId,
		nextRunAt: '2026-04-20T00:00:00.000Z',
		enabled: false,
	})
	await insertJob({
		id: 'kill-switched',
		userId,
		nextRunAt: '2026-04-20T00:00:00.000Z',
		killSwitchEnabled: true,
	})
	await insertJob({
		id: 'future',
		userId,
		nextRunAt: '2026-04-21T00:00:00.000Z',
	})

	const firstBatch = await listDueJobRows(env.APP_DB, userId, nowIso)
	expect(firstBatch).toHaveLength(maxDueJobsPerAlarm)
	expect(firstBatch.map((row) => row.id)).toEqual(
		Array.from(
			{ length: maxDueJobsPerAlarm },
			(_, index) => `due-${String(index).padStart(3, '0')}`,
		),
	)

	// Once the first batch has been rescheduled out of the due window, the next
	// alarm invocation picks up the remainder of the backlog.
	for (const row of firstBatch) {
		await env.APP_DB.prepare(`UPDATE jobs SET next_run_at = ? WHERE id = ?`)
			.bind('2026-04-22T00:00:00.000Z', row.id)
			.run()
	}
	const secondBatch = await listDueJobRows(env.APP_DB, userId, nowIso)
	expect(secondBatch.map((row) => row.id)).toEqual(
		Array.from(
			{ length: backlogSize - maxDueJobsPerAlarm },
			(_, index) =>
				`due-${String(maxDueJobsPerAlarm + index).padStart(3, '0')}`,
		),
	)
})
