import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { loadAdminFunnelSummary } from './admin-funnel.ts'

const now = new Date('2026-09-19T12:00:00.000Z')

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('loadAdminFunnelSummary counts distinct accounts for 7 and 28 days from D1', async () => {
	const { sqlite, db } = createDb()
	const insert = sqlite.prepare(
		`INSERT INTO funnel_events (event, user_id, occurred_at, plan, card_id)
		 VALUES (?, ?, ?, '', '')`,
	)
	insert.run('signup_completed', 'user-a', '2026-09-18T00:00:00.000Z')
	insert.run('signup_completed', 'user-a', '2026-09-18T01:00:00.000Z')
	insert.run('signup_completed', 'user-b', '2026-08-30T00:00:00.000Z')
	insert.run('signup_started', '', '2026-09-18T00:00:00.000Z')
	insert.run('signup_started', '', '2026-09-17T00:00:00.000Z')
	insert.run('first_search', 'user-a', '2026-08-01T00:00:00.000Z')

	const summary = await loadAdminFunnelSummary({
		env: { APP_DB: db, WRANGLER_IS_LOCAL_DEV: 'true' },
		now,
	})
	expect(summary.source).toBe('d1')
	const signup = summary.stages.find(
		(stage) => stage.event === 'signup_completed',
	)
	const started = summary.stages.find(
		(stage) => stage.event === 'signup_started',
	)
	const search = summary.stages.find((stage) => stage.event === 'first_search')
	expect(signup).toEqual({ event: 'signup_completed', days7: 1, days28: 2 })
	expect(started).toEqual({ event: 'signup_started', days7: 2, days28: 2 })
	expect(search).toEqual({ event: 'first_search', days7: 0, days28: 0 })
})
