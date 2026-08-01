import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { logAuditEvent } from './audit-log.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

vi.unmock('#worker/audit-log.ts')

function createAuditDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL('../audit-migrations/0001-audit-events.sql', import.meta.url),
			'utf8',
		),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('persisted audit events dual-write while optional persistence stays optional', async () => {
	const legacy = createAuditDb()
	const audit = createAuditDb()

	await logAuditEvent({
		db: legacy.db,
		auditDb: audit.db,
		category: 'auth',
		action: 'authenticate',
		result: 'failure',
		email: 'Person@Example.com',
		ip: '192.0.2.1',
		path: '/login',
		reason: 'invalid_password',
	})
	await logAuditEvent({
		auditDb: audit.db,
		category: 'account',
		action: 'profile_view',
		result: 'success',
	})

	const query = `SELECT category, action, result, email_hash, ip_hash, path, reason
		FROM audit_events`
	const legacyRows = legacy.sqlite.prepare(query).all()
	const auditRows = audit.sqlite.prepare(query).all()
	expect(legacyRows).toEqual(auditRows)
	expect(legacyRows).toEqual([
		{
			category: 'auth',
			action: 'authenticate',
			result: 'failure',
			email_hash:
				'542d240129883c019e106e3b1b2d3f3cb3537c43c425364de8e951d5a3083345',
			ip_hash:
				'37fcff24bf62035b2b08020afc08b4fecd4fcffce57ab23518e3561ff0fe76b9',
			path: '/login',
			reason: 'invalid_password',
		},
	])
})
