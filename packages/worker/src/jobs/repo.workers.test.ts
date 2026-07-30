import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	claimJobRow,
	finalizeClaimedJobRow,
	getJobRowById,
	getNextRunnableJobRow,
	jobExecutionLeaseMs,
	listDueJobRows,
	maxDueJobsPerAlarm,
	retryClaimedJobRow,
	updateJobRow,
} from './repo.ts'

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
			preserved INTEGER NOT NULL DEFAULT 0 CHECK (preserved IN (0, 1)),
			expires_at TEXT,
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
			claim_token TEXT,
			running_since TEXT,
			lease_expires_at TEXT,
			claimed_scheduled_for TEXT,
			retry_scheduled_for TEXT,
			retry_count INTEGER NOT NULL DEFAULT 0,
			last_completed_scheduled_for TEXT
		)`,
	).run()
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE jobs ADD COLUMN expires_at TEXT`,
		).run()
	} catch {
		// Column already present when migrations or a prior CREATE included it.
	}
	await env.APP_DB.prepare(`DELETE FROM jobs`).run()
}

async function insertJob(input: {
	id: string
	userId: string
	nextRunAt: string
	enabled?: boolean
	killSwitchEnabled?: boolean
	expiresAt?: string | null
}) {
	const now = '2026-04-20T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT INTO jobs (
			id, user_id, name, source_id, storage_id, schedule_json, timezone,
			enabled, kill_switch_enabled, expires_at, caller_context_json, created_at,
			updated_at, next_run_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'null', ?, ?, ?)`,
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
			input.expiresAt ?? null,
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
		id: 'expired',
		userId,
		nextRunAt: '2026-04-20T00:00:00.000Z',
		expiresAt: '2026-04-19T23:00:00.000Z',
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

test('conditional job claims exclude overlap and reclaim only after lease expiry', async () => {
	await ensureJobsSchema()
	const userId = 'user-claim'
	const scheduledFor = '2026-04-20T12:00:00.000Z'
	const now = new Date(scheduledFor)
	await insertJob({
		id: 'claimed-job',
		userId,
		nextRunAt: scheduledFor,
	})

	const [first, overlap] = await Promise.all([
		claimJobRow({
			db: env.APP_DB,
			userId,
			jobId: 'claimed-job',
			now,
			claimToken: 'claim-first',
		}),
		claimJobRow({
			db: env.APP_DB,
			userId,
			jobId: 'claimed-job',
			now,
			claimToken: 'claim-overlap',
		}),
	])
	const winner = first ?? overlap
	expect(winner).not.toBeNull()
	expect([first, overlap].filter(Boolean)).toHaveLength(1)
	expect(winner?.claimed_scheduled_for).toBe(scheduledFor)
	expect(winner?.lease_expires_at).toBe(
		new Date(now.valueOf() + jobExecutionLeaseMs).toISOString(),
	)

	expect(
		await listDueJobRows(
			env.APP_DB,
			userId,
			new Date(now.valueOf() + jobExecutionLeaseMs - 1).toISOString(),
		),
	).toEqual([])
	const nextWhileLeased = await getNextRunnableJobRow(
		env.APP_DB,
		userId,
		now.toISOString(),
	)
	expect(nextWhileLeased?.schedulerWakeAt).toBe(winner?.lease_expires_at)

	const reclaimed = await claimJobRow({
		db: env.APP_DB,
		userId,
		jobId: 'claimed-job',
		now: new Date(now.valueOf() + jobExecutionLeaseMs),
		claimToken: 'claim-reclaimed',
	})
	expect(reclaimed?.claim_token).toBe('claim-reclaimed')
	expect(reclaimed?.claimed_scheduled_for).toBe(scheduledFor)

	const retryAt = '2026-04-20T12:10:05.000Z'
	expect(
		await retryClaimedJobRow({
			db: env.APP_DB,
			userId,
			jobId: 'claimed-job',
			claimToken: 'claim-reclaimed',
			nextRunAt: retryAt,
		}),
	).toBe(true)
	const retryRow = await getNextRunnableJobRow(
		env.APP_DB,
		userId,
		new Date('2026-04-20T12:10:00.000Z').toISOString(),
	)
	expect(retryRow).toMatchObject({
		claim_token: null,
		retry_scheduled_for: scheduledFor,
		retry_count: 1,
		schedulerWakeAt: retryAt,
	})
	const retriedOccurrence = await claimJobRow({
		db: env.APP_DB,
		userId,
		jobId: 'claimed-job',
		now: new Date(retryAt),
		claimToken: 'claim-retry',
	})
	expect(retriedOccurrence?.claimed_scheduled_for).toBe(scheduledFor)
	expect(retriedOccurrence?.retry_count).toBe(1)
})

test('ordinary updates cancel claims and completed occurrence guards fence malformed due rows', async () => {
	await ensureJobsSchema()
	const userId = 'user-fencing'
	const scheduledFor = '2026-04-20T12:00:00.000Z'
	await insertJob({
		id: 'cancelled-claim',
		userId,
		nextRunAt: scheduledFor,
	})
	const claimed = await claimJobRow({
		db: env.APP_DB,
		userId,
		jobId: 'cancelled-claim',
		now: new Date(scheduledFor),
		claimToken: 'stale-token',
	})
	if (!claimed) throw new Error('Expected job claim.')

	expect(
		await updateJobRow({
			db: env.APP_DB,
			userId,
			job: {
				...claimed.record,
				name: 'Edited while claimed',
			},
			callerContextJson: claimed.callerContextJson,
		}),
	).toBe(true)
	expect(await getJobRowById(env.APP_DB, userId, claimed.id)).toMatchObject({
		name: 'Edited while claimed',
		claim_token: null,
		running_since: null,
		lease_expires_at: null,
		claimed_scheduled_for: null,
		retry_scheduled_for: null,
		retry_count: 0,
	})
	expect(
		await finalizeClaimedJobRow({
			db: env.APP_DB,
			userId,
			job: claimed.record,
			callerContextJson: claimed.callerContextJson,
			claimToken: 'stale-token',
			scheduledFor,
		}),
	).toBe(false)

	await insertJob({
		id: 'already-completed',
		userId,
		nextRunAt: scheduledFor,
	})
	await env.APP_DB.prepare(
		`UPDATE jobs SET last_completed_scheduled_for = ? WHERE id = ? AND user_id = ?`,
	)
		.bind(scheduledFor, 'already-completed', userId)
		.run()
	const due = await listDueJobRows(env.APP_DB, userId, scheduledFor)
	expect(due.map((row) => row.id)).not.toContain('already-completed')
	expect(
		await claimJobRow({
			db: env.APP_DB,
			userId,
			jobId: 'already-completed',
			now: new Date(scheduledFor),
			claimToken: 'must-not-claim',
		}),
	).toBeNull()
})

test('expired jobs are skipped by due/claim/next-runnable and disableExpired flips enabled', async () => {
	await ensureJobsSchema()
	const { disableExpiredJobRowsForUser } = await import('./repo.ts')
	const userId = 'user-expires'
	const nowIso = '2026-04-20T12:00:00.000Z'
	await insertJob({
		id: 'still-valid',
		userId,
		nextRunAt: '2026-04-20T11:00:00.000Z',
		expiresAt: '2026-04-20T13:00:00.000Z',
	})
	await insertJob({
		id: 'already-expired',
		userId,
		nextRunAt: '2026-04-20T11:00:00.000Z',
		expiresAt: '2026-04-20T11:30:00.000Z',
	})
	await insertJob({
		id: 'no-expiry',
		userId,
		nextRunAt: '2026-04-20T11:00:00.000Z',
	})

	const due = await listDueJobRows(env.APP_DB, userId, nowIso)
	expect(due.map((row) => row.id).sort()).toEqual(['no-expiry', 'still-valid'])

	expect(
		await claimJobRow({
			db: env.APP_DB,
			userId,
			jobId: 'already-expired',
			now: new Date(nowIso),
			claimToken: 'should-fail',
		}),
	).toBeNull()

	const next = await getNextRunnableJobRow(env.APP_DB, userId, nowIso)
	expect(next?.id).toBe('no-expiry')

	expect(
		await disableExpiredJobRowsForUser({
			db: env.APP_DB,
			userId,
			nowIso,
		}),
	).toBe(1)
	const disabled = await getJobRowById(env.APP_DB, userId, 'already-expired')
	expect(disabled).toMatchObject({
		enabled: 0,
		expires_at: '2026-04-20T11:30:00.000Z',
	})
	expect(disabled?.record.expiresAt).toBe('2026-04-20T11:30:00.000Z')
})

test('getNextRunnableJobRow wakes at expires_at when it is earlier than next_run_at', async () => {
	await ensureJobsSchema()
	const userId = 'user-expires-wake'
	await insertJob({
		id: 'expires-before-run',
		userId,
		nextRunAt: '2026-04-21T12:00:00.000Z',
		expiresAt: '2026-04-20T18:00:00.000Z',
	})
	const next = await getNextRunnableJobRow(
		env.APP_DB,
		userId,
		'2026-04-20T12:00:00.000Z',
	)
	expect(next).toMatchObject({
		id: 'expires-before-run',
		schedulerWakeAt: '2026-04-20T18:00:00.000Z',
	})
})
