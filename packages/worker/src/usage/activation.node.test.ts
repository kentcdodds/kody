import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	recordActivationMilestone,
	recordSuccessfulPackageRun,
} from './activation.ts'

function createActivationDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL(
				'../../migrations/0037-package-runtime-debug.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	sqlite.exec(`
		CREATE TABLE user_activation_milestones (
			user_id TEXT NOT NULL,
			milestone TEXT NOT NULL CHECK (
				milestone IN ('package_run_succeeded', 'package_activated')
			),
			reached_at TEXT NOT NULL,
			package_id TEXT,
			PRIMARY KEY (user_id, milestone)
		);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function insertRun(
	sqlite: DatabaseSync,
	input: {
		id: string
		userId: string
		packageId: string
		status: 'success' | 'error'
		startedAt: string
	},
) {
	sqlite
		.prepare(
			`INSERT INTO package_runtime_runs (
				id, user_id, package_id, package_kody_id, surface, status,
				started_at, created_at, updated_at
			) VALUES (?, ?, ?, 'kody-id', 'job', ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.userId,
			input.packageId,
			input.status,
			input.startedAt,
			input.startedAt,
			input.startedAt,
		)
}

function listMilestones(sqlite: DatabaseSync, userId: string) {
	return sqlite
		.prepare(
			`SELECT milestone, package_id FROM user_activation_milestones
			 WHERE user_id = ? ORDER BY milestone`,
		)
		.all(userId) as Array<{ milestone: string; package_id: string | null }>
}

test('activation requires the same package to succeed twice', async () => {
	const { sqlite, db } = createActivationDb()
	const env = { APP_DB: db }

	insertRun(sqlite, {
		id: 'run-1',
		userId: 'user-1',
		packageId: 'pkg-a',
		status: 'success',
		startedAt: '2026-07-01T00:00:00.000Z',
	})
	await recordSuccessfulPackageRun(env, {
		userId: 'user-1',
		packageId: 'pkg-a',
	})
	expect(listMilestones(sqlite, 'user-1').map((row) => row.milestone)).toEqual([
		'package_run_succeeded',
	])

	// A different package succeeding once is still a user in setup, not a user
	// with something working unattended.
	insertRun(sqlite, {
		id: 'run-2',
		userId: 'user-1',
		packageId: 'pkg-b',
		status: 'success',
		startedAt: '2026-07-02T00:00:00.000Z',
	})
	await recordSuccessfulPackageRun(env, {
		userId: 'user-1',
		packageId: 'pkg-b',
	})
	expect(listMilestones(sqlite, 'user-1').map((row) => row.milestone)).toEqual([
		'package_run_succeeded',
	])

	insertRun(sqlite, {
		id: 'run-3',
		userId: 'user-1',
		packageId: 'pkg-a',
		status: 'success',
		startedAt: '2026-07-03T00:00:00.000Z',
	})
	await recordSuccessfulPackageRun(env, {
		userId: 'user-1',
		packageId: 'pkg-a',
	})
	expect(listMilestones(sqlite, 'user-1')).toEqual([
		{ milestone: 'package_activated', package_id: 'pkg-a' },
		{ milestone: 'package_run_succeeded', package_id: 'pkg-a' },
	])
})

test('milestones keep their first timestamp and failed runs never activate', async () => {
	const { sqlite, db } = createActivationDb()
	const env = { APP_DB: db }

	await recordActivationMilestone(env, {
		userId: 'user-2',
		milestone: 'package_run_succeeded',
		packageId: 'pkg-a',
		reachedAt: '2026-07-01T00:00:00.000Z',
	})
	await recordActivationMilestone(env, {
		userId: 'user-2',
		milestone: 'package_run_succeeded',
		packageId: 'pkg-z',
		reachedAt: '2026-07-09T00:00:00.000Z',
	})
	const row = sqlite
		.prepare(
			`SELECT reached_at, package_id FROM user_activation_milestones
			 WHERE user_id = 'user-2' AND milestone = 'package_run_succeeded'`,
		)
		.get() as { reached_at: string; package_id: string }
	expect(row).toEqual({
		reached_at: '2026-07-01T00:00:00.000Z',
		package_id: 'pkg-a',
	})

	// Two failed runs of one package must not count toward activation.
	insertRun(sqlite, {
		id: 'run-e1',
		userId: 'user-3',
		packageId: 'pkg-c',
		status: 'error',
		startedAt: '2026-07-01T00:00:00.000Z',
	})
	insertRun(sqlite, {
		id: 'run-e2',
		userId: 'user-3',
		packageId: 'pkg-c',
		status: 'error',
		startedAt: '2026-07-02T00:00:00.000Z',
	})
	await recordSuccessfulPackageRun(env, {
		userId: 'user-3',
		packageId: 'pkg-c',
	})
	expect(listMilestones(sqlite, 'user-3').map((row) => row.milestone)).toEqual([
		'package_run_succeeded',
	])
})

test('activation instrumentation never throws without a database', async () => {
	await expect(
		recordSuccessfulPackageRun({}, { userId: 'user-1', packageId: 'pkg-a' }),
	).resolves.toBeUndefined()
	await expect(
		recordActivationMilestone(
			{},
			{ userId: 'user-1', milestone: 'package_activated' },
		),
	).resolves.toBeUndefined()
})
