import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	countsTowardPackageActivation,
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
		CREATE TABLE user_package_run_successes (
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			success_count INTEGER NOT NULL CHECK (success_count >= 0),
			updated_at TEXT NOT NULL,
			PRIMARY KEY (user_id, package_id)
		);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function listMilestones(sqlite: DatabaseSync, userId: string) {
	return sqlite
		.prepare(
			`SELECT milestone, package_id FROM user_activation_milestones
			 WHERE user_id = ? ORDER BY milestone`,
		)
		.all(userId) as Array<{ milestone: string; package_id: string | null }>
}

function listSuccessCounts(sqlite: DatabaseSync, userId: string) {
	return sqlite
		.prepare(
			`SELECT package_id, success_count FROM user_package_run_successes
			 WHERE user_id = ? ORDER BY package_id`,
		)
		.all(userId) as Array<{ package_id: string; success_count: number }>
}

test('activation requires the same package to succeed twice and ignores HTTP surfaces', async () => {
	const { sqlite, db } = createActivationDb()
	const env = { APP_DB: db }

	expect(countsTowardPackageActivation('webhook')).toBe(false)
	expect(countsTowardPackageActivation('app_fetch')).toBe(false)
	expect(countsTowardPackageActivation('job')).toBe(true)
	expect(countsTowardPackageActivation(undefined)).toBe(true)

	await recordSuccessfulPackageRun(env, {
		userId: 'user-1',
		packageId: 'pkg-a',
		surface: 'job',
	})
	expect(listMilestones(sqlite, 'user-1').map((row) => row.milestone)).toEqual([
		'package_run_succeeded',
	])
	expect(listSuccessCounts(sqlite, 'user-1')).toEqual([
		{ package_id: 'pkg-a', success_count: 1 },
	])

	await recordSuccessfulPackageRun(env, {
		userId: 'user-1',
		packageId: 'pkg-b',
		surface: 'service',
	})
	expect(listMilestones(sqlite, 'user-1').map((row) => row.milestone)).toEqual([
		'package_run_succeeded',
	])
	expect(listSuccessCounts(sqlite, 'user-1')).toEqual([
		{ package_id: 'pkg-a', success_count: 1 },
		{ package_id: 'pkg-b', success_count: 1 },
	])

	await recordSuccessfulPackageRun(env, {
		userId: 'user-http',
		packageId: 'pkg-a',
		surface: 'webhook',
	})
	await recordSuccessfulPackageRun(env, {
		userId: 'user-http',
		packageId: 'pkg-a',
		surface: 'app_fetch',
	})
	expect(listMilestones(sqlite, 'user-http')).toEqual([])
	expect(listSuccessCounts(sqlite, 'user-http')).toEqual([])

	await recordSuccessfulPackageRun(env, {
		userId: 'user-1',
		packageId: 'pkg-a',
		surface: 'job',
	})
	expect(listMilestones(sqlite, 'user-1')).toEqual([
		{ milestone: 'package_activated', package_id: 'pkg-a' },
		{ milestone: 'package_run_succeeded', package_id: 'pkg-a' },
	])
	expect(listSuccessCounts(sqlite, 'user-1')).toEqual([
		{ package_id: 'pkg-a', success_count: 2 },
		{ package_id: 'pkg-b', success_count: 1 },
	])

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
	const sticky = sqlite
		.prepare(
			`SELECT reached_at, package_id FROM user_activation_milestones
			 WHERE user_id = 'user-2' AND milestone = 'package_run_succeeded'`,
		)
		.get() as { reached_at: string; package_id: string }
	expect(sticky).toEqual({
		reached_at: '2026-07-01T00:00:00.000Z',
		package_id: 'pkg-a',
	})

	await recordActivationMilestone(env, {
		userId: 'user-fast',
		milestone: 'package_activated',
		packageId: 'pkg-a',
		reachedAt: '2026-07-01T00:00:00.000Z',
	})
	const prepareCalls: Array<string> = []
	const originalPrepare = db.prepare.bind(db)
	db.prepare = ((query: string) => {
		prepareCalls.push(query.replace(/\s+/g, ' ').trim())
		return originalPrepare(query)
	}) as typeof db.prepare
	await recordSuccessfulPackageRun(env, {
		userId: 'user-fast',
		packageId: 'pkg-a',
		surface: 'job',
	})
	await recordSuccessfulPackageRun(env, {
		userId: 'user-fast',
		packageId: 'pkg-b',
		surface: 'workflow',
	})
	expect(prepareCalls).toEqual([
		'SELECT 1 AS n FROM user_activation_milestones WHERE user_id = ?1 AND milestone = ?2',
		'SELECT 1 AS n FROM user_activation_milestones WHERE user_id = ?1 AND milestone = ?2',
	])
	expect(listSuccessCounts(sqlite, 'user-fast')).toEqual([])
})

test('activation instrumentation never throws without a database or on write failure', async () => {
	await expect(
		recordSuccessfulPackageRun({}, { userId: 'user-1', packageId: 'pkg-a' }),
	).resolves.toBeUndefined()
	await expect(
		recordActivationMilestone(
			{},
			{ userId: 'user-1', milestone: 'package_activated' },
		),
	).resolves.toBeUndefined()

	consoleWarn.mockImplementation(() => {})
	const env = {
		APP_DB: {
			prepare() {
				throw new Error('d1 unavailable')
			},
		} as unknown as D1Database,
	}
	await expect(
		recordSuccessfulPackageRun(env, {
			userId: 'user-1',
			packageId: 'pkg-a',
			surface: 'job',
		}),
	).resolves.toBeUndefined()
	expect(consoleWarn).toHaveBeenCalledWith(
		'activation-run-record-failed',
		expect.any(Error),
	)
})
