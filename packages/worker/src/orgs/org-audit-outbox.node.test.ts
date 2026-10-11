import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	drainOrgAuditOutbox,
	enqueueOrgAuditOutbox,
} from './org-audit-outbox.ts'

function createAppDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

test('drain delivers outbox rows to AUDIT_DB and clears the queue', async () => {
	const appDb = createAppDb()
	const auditDb = createAuditTestDb()
	const writer = {
		appDb,
		db: auditDb,
		actorUserId: 'actor-1',
		actorUsername: null,
		credentialKind: null,
		credentialId: null,
	}
	const plan = await enqueueOrgAuditOutbox(writer, {
		orgId: 'org-1',
		action: 'member.added',
		targetUserId: 'user-2',
		details: { role: 'member' },
	})
	const pending = await appDb
		.prepare(`SELECT COUNT(*) AS count FROM org_audit_outbox`)
		.first<{ count: number }>()
	expect(pending?.count).toBe(1)

	const result = await drainOrgAuditOutbox({
		env: { APP_DB: appDb, AUDIT_DB: auditDb } as Env,
	})
	expect(result).toMatchObject({ status: 'ok', delivered: 1, remaining: 0 })

	const auditRow = await auditDb
		.prepare(`SELECT id, action FROM org_audit_events WHERE id = ?`)
		.bind(plan.outboxId)
		.first<{ id: string; action: string }>()
	expect(auditRow).toEqual({ id: plan.outboxId, action: 'member.added' })
})
