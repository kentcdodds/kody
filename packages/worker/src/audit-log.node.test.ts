import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { logAuditEvent } from './audit-log.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

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

function createAuditDbWithRun(run: () => Promise<unknown>) {
	return {
		prepare() {
			return {
				bind() {
					return { run }
				},
			}
		},
	} as unknown as D1Database
}

test('audit dual writes retry transient errors and report partial sink failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const transientRun = vi
		.fn()
		.mockRejectedValueOnce(new Error('D1_ERROR: Network connection lost'))
		.mockResolvedValueOnce({ meta: { changes: 1 } })
	const retryAudit = createAuditDb()
	const retryResult = await logAuditEvent({
		db: createAuditDbWithRun(transientRun),
		auditDb: retryAudit.db,
		category: 'account',
		action: 'transient_retry',
		result: 'success',
	})
	expect(retryResult).toEqual({ persisted: true, failedSinks: [] })
	expect(transientRun).toHaveBeenCalledTimes(2)
	expect(
		retryAudit.sqlite
			.prepare(`SELECT COUNT(*) AS count FROM audit_events`)
			.get(),
	).toEqual({ count: 1 })

	const successfulAudit = createAuditDb()
	const failedAppResult = await logAuditEvent({
		db: createAuditDbWithRun(() =>
			Promise.reject(new Error('APP_DB permanent failure')),
		),
		auditDb: successfulAudit.db,
		category: 'account',
		action: 'app_failed',
		result: 'failure',
	})
	expect(failedAppResult).toEqual({
		persisted: false,
		failedSinks: ['APP_DB'],
	})
	expect(
		successfulAudit.sqlite
			.prepare(`SELECT COUNT(*) AS count FROM audit_events`)
			.get(),
	).toEqual({ count: 1 })

	const successfulApp = createAuditDb()
	const failedAuditResult = await logAuditEvent({
		db: successfulApp.db,
		auditDb: createAuditDbWithRun(() =>
			Promise.reject(new Error('AUDIT_DB permanent failure')),
		),
		category: 'account',
		action: 'audit_failed',
		result: 'failure',
	})
	expect(failedAuditResult).toEqual({
		persisted: false,
		failedSinks: ['AUDIT_DB'],
	})
	expect(
		successfulApp.sqlite
			.prepare(`SELECT COUNT(*) AS count FROM audit_events`)
			.get(),
	).toEqual({ count: 1 })
	expect(consoleWarn).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith('audit-event-write-failed', {
		failedSinks: ['APP_DB'],
		errors: [expect.any(Error)],
	})
	expect(consoleWarn).toHaveBeenCalledWith('audit-event-write-failed', {
		failedSinks: ['AUDIT_DB'],
		errors: [expect.any(Error)],
	})
})
