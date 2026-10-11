import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	deliverOrgAuditOutboxPayload,
	drainOrgAuditOutbox,
	enqueueOrgAuditOutbox,
	tryDeliverOrgAuditOutboxPlan,
} from './org-audit-outbox.ts'
import { redactOrgAuditActorIdsForDeletedUser } from './org-audit.ts'

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

test('delivery clears outbox when AUDIT_DB row already exists', async () => {
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
		action: 'team.created',
		resourceType: 'team',
		resourceId: 'team-1',
	})
	await deliverOrgAuditOutboxPayload(auditDb, plan.payload)
	const redeliver = await tryDeliverOrgAuditOutboxPlan(writer, plan)
	expect(redeliver).toBe(true)
	const pending = await appDb
		.prepare(`SELECT COUNT(*) AS count FROM org_audit_outbox`)
		.first<{ count: number }>()
	expect(pending?.count).toBe(0)
})

test('user purge redacts pending outbox actor ids', async () => {
	const appDb = createAppDb()
	const auditDb = createAuditTestDb()
	const userId = 'user-to-purge'
	const writer = {
		appDb,
		db: auditDb,
		actorUserId: userId,
		actorUsername: 'purge-me',
		credentialKind: null,
		credentialId: null,
	}
	await enqueueOrgAuditOutbox(writer, {
		orgId: 'org-1',
		action: 'member.added',
		targetUserId: 'other',
	})
	await redactOrgAuditActorIdsForDeletedUser({
		env: { APP_DB: appDb, AUDIT_DB: auditDb } as Env,
		userId,
	})
	const row = await appDb
		.prepare(`SELECT payload_json FROM org_audit_outbox LIMIT 1`)
		.first<{ payload_json: string }>()
	expect(JSON.parse(row?.payload_json ?? '{}')).toMatchObject({
		actorUserId: 'deleted-user',
		actorUsername: 'purge-me',
	})
})
