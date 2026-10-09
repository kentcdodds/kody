import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrg } from './provision.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	OrgRestoreWindowExpiredError,
	UserDeleteBlockedSoleOwnerError,
	assertUserDeleteNotBlockedAsSoleOwner,
	restoreOrg,
	softDeleteOrg,
} from './soft-delete.ts'
import * as JobManager from '#worker/jobs/manager-client.ts'

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		softDeleteJobsForUser: vi.fn(async () => 0),
		restoreJobsForUser: vi.fn(async () => 0),
	}),
	jobsService: () => null,
}))

vi.spyOn(JobManager, 'syncJobManagerAlarm').mockResolvedValue({
	ok: true,
	userId: 'mock',
	nextRunAt: null,
})

const now = new Date('2026-10-01T12:00:00.000Z')

function createAuditDb() {
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(
		readFileSync(
			new URL(
				'../../audit-migrations/0002-org-audit-events.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	return createD1FromSqlite(auditSqlite)
}

async function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const env = {
		APP_DB: appDb,
		AUDIT_DB: auditDb,
	} as Env
	return { env, appDb, auditDb }
}

async function seedOrg(db: D1Database, orgId: string, slug: string) {
	const ts = '2026-01-01T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, entitlement_ladder, created_at, updated_at)
			VALUES (?, ?, ?, 'free', 'public', ?, ?)`,
		)
		.bind(orgId, slug, slug, ts, ts)
		.run()
}

test('soft delete and restore org within the restore window', async () => {
	const { env, appDb, auditDb } = await createHarness()
	const orgId = 'org-team-alpha'
	await seedOrg(appDb, orgId, 'team-alpha')
	const deleted = await softDeleteOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now,
	})
	expect(deleted.deletedAt).toBeTruthy()
	const tombstoned = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind(orgId)
		.first<{ deleted_at: string | null }>()
	expect(tombstoned?.deleted_at).toBe(deleted.deletedAt)
	const restoreNow = new Date(now.getTime() + 60_000)
	await restoreOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now: restoreNow,
	})
	const live = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind(orgId)
		.first<{ deleted_at: string | null }>()
	expect(live?.deleted_at).toBeNull()
	const audits = await auditDb
		.prepare(
			`SELECT action FROM org_audit_events WHERE org_id = ? ORDER BY created_at ASC`,
		)
		.bind(orgId)
		.all<{ action: string }>()
	expect((audits.results ?? []).map((row) => row.action).sort()).toEqual([
		'org.deleted',
		'org.restored',
	])
})

test('restore outside the 30-day window fails', async () => {
	const { env, appDb } = await createHarness()
	const orgId = 'org-old-delete'
	await seedOrg(appDb, orgId, 'old-delete')
	const oldDeletedAt = '2025-08-01T00:00:00.000Z'
	await appDb
		.prepare(`UPDATE orgs SET deleted_at = ?, updated_at = ? WHERE id = ?`)
		.bind(oldDeletedAt, oldDeletedAt, orgId)
		.run()
	await expect(
		restoreOrg({ env, orgId, now: new Date('2026-10-01T00:00:00.000Z') }),
	).rejects.toBeInstanceOf(OrgRestoreWindowExpiredError)
})

test('user delete blocked when sole owner of multi-member org', async () => {
	const { appDb } = await createHarness()
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	const orgId = 'org-shared'
	await seedOrg(appDb, orgId, 'shared')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			VALUES (?, ?, 'owner', ?), (?, ?, 'member', ?)`,
		)
		.bind(orgId, ownerId, ts, orgId, memberId, ts)
		.run()
	await expect(
		assertUserDeleteNotBlockedAsSoleOwner({ db: appDb, userId: ownerId }),
	).rejects.toBeInstanceOf(UserDeleteBlockedSoleOwnerError)
})

test('personal org provision path supports soft delete audit', async () => {
	const { env, appDb, auditDb } = await createHarness()
	const stableUserId = testStableUserIdFromEmail('solo@example.com')
	await provisionPersonalOrg(appDb, {
		stableUserId,
		username: 'solo',
		createdAt: '2026-01-01T00:00:00.000Z',
		accountType: 'person',
		plan: 'free',
	})
	await softDeleteOrg({
		env,
		orgId: stableUserId,
		actorUserId: stableUserId,
		now,
	})
	const audit = await auditDb
		.prepare(`SELECT action FROM org_audit_events WHERE org_id = ?`)
		.bind(stableUserId)
		.first<{ action: string }>()
	expect(audit?.action).toBe('org.deleted')
})
