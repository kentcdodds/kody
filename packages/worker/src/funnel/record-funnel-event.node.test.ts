import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	sanitizeClientFamily,
	sanitizeFunnelErrorClass,
	sanitizeWaitingCardId,
} from '#universal/funnel-events.ts'
import { recordFunnelEvent } from './record-funnel-event.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, first_search_at
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.run('ada', 'ada@example.com', 'hash', 'user-ada', null)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('sanitize collapses raw client ids, error sentences, and secret-like card ids', () => {
	expect(sanitizeClientFamily('cursor')).toBe('cursor')
	expect(sanitizeClientFamily('Claude Desktop')).toBe('claude-desktop')
	expect(sanitizeClientFamily('oauth-client-9f3a')).toBe('unknown')
	expect(sanitizeFunnelErrorClass('email_verification_required')).toBe(
		'email_verification_required',
	)
	expect(sanitizeFunnelErrorClass('Invalid email or password.')).toBe('other')
	expect(sanitizeWaitingCardId('first-use:search')).toBe('first-use:search')
	expect(sanitizeWaitingCardId('server-uuid-raw')).toBe('other')
	expect(sanitizeWaitingCardId('user@example.com')).toBe('other')
})

test('recordFunnelEvent writes one Analytics Engine point and one D1 row', async () => {
	const { sqlite, db } = createDb()
	const writeDataPoint = vi.fn()
	await recordFunnelEvent(
		{
			APP_DB: db,
			FUNNEL_EVENTS: { writeDataPoint },
		},
		{
			event: 'signup_completed',
			stableUserId: 'user-ada',
			clientFamily: 'oauth-secret-client',
			errorClass: 'not an error class',
			plan: 'standard',
		},
	)
	expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
		indexes: ['signup_completed'],
		blobs: ['signup_completed', 'user-ada', 'unknown', 'other', 'standard', ''],
		doubles: [1],
	})
	const row = sqlite
		.prepare(`SELECT event, user_id, client_family, plan FROM funnel_events`)
		.get() as {
		event: string
		user_id: string
		client_family: string
		plan: string
	}
	expect(row).toEqual({
		event: 'signup_completed',
		user_id: 'user-ada',
		client_family: 'unknown',
		plan: 'standard',
	})
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('secret')
})

test('first_search is skipped when the activation stamp is already set and claimed once otherwise', async () => {
	const { sqlite, db } = createDb()
	sqlite
		.prepare(`UPDATE users SET first_search_at = ? WHERE stable_user_id = ?`)
		.run('2026-09-01T00:00:00.000Z', 'user-ada')
	const writeDataPoint = vi.fn()
	await recordFunnelEvent(
		{ APP_DB: db, FUNNEL_EVENTS: { writeDataPoint } },
		{ event: 'first_search', stableUserId: 'user-ada' },
	)
	expect(writeDataPoint).not.toHaveBeenCalled()

	sqlite
		.prepare(`UPDATE users SET first_search_at = NULL WHERE stable_user_id = ?`)
		.run('user-ada')
	await recordFunnelEvent(
		{ APP_DB: db, FUNNEL_EVENTS: { writeDataPoint } },
		{ event: 'first_search', stableUserId: 'user-ada' },
	)
	await recordFunnelEvent(
		{ APP_DB: db, FUNNEL_EVENTS: { writeDataPoint } },
		{ event: 'first_search', stableUserId: 'user-ada' },
	)
	expect(writeDataPoint).toHaveBeenCalledTimes(1)
	const claims = sqlite
		.prepare(`SELECT COUNT(*) AS n FROM funnel_first_claims`)
		.get() as { n: number }
	expect(claims.n).toBe(1)
})

test('signup_started records a page load without a user id', async () => {
	const { sqlite, db } = createDb()
	await recordFunnelEvent({ APP_DB: db }, { event: 'signup_started' })
	const row = sqlite
		.prepare(`SELECT event, user_id FROM funnel_events`)
		.get() as { event: string; user_id: string }
	expect(row).toEqual({ event: 'signup_started', user_id: '' })
})
