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
	assertActorCanRestoreSoftDeletedOrg,
	assertUserDeleteNotBlockedAsSoleOwner,
	restoreOrg,
	restoreResourceRow,
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

test('only a deletion-generation owner can restore a soft-deleted org', async () => {
	const { env, appDb } = await createHarness()
	const orgId = 'org-restore-auth'
	const ownerId = 'owner-restore-1'
	const memberId = 'member-restore-1'
	await seedOrg(appDb, orgId, 'restore-auth')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?), (?, ?, 'member', ?)`,
		)
		.bind(orgId, ownerId, ts, orgId, memberId, ts)
		.run()
	await softDeleteOrg({
		env,
		orgId,
		actorUserId: ownerId,
		now,
	})
	await expect(
		assertActorCanRestoreSoftDeletedOrg({
			db: appDb,
			orgId,
			actorUserId: memberId,
		}),
	).rejects.toThrow('org_restore_forbidden')
	const allowed = await assertActorCanRestoreSoftDeletedOrg({
		db: appDb,
		orgId,
		actorUserId: ownerId,
	})
	expect(allowed.deletedAt).toBeTruthy()
})

test('org soft delete revokes team-bound API tokens and bootstrap codes', async () => {
	const { env, appDb } = await createHarness()
	const orgId = 'org-token-revoke'
	const memberId = 'member-token-1'
	await seedOrg(appDb, orgId, 'token-revoke')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO api_tokens (
				id, user_id, org_id, name, token_hash, scopes_json,
				idle_ttl_seconds, expires_at, max_expires_at, created_via,
				created_at, updated_at
			) VALUES (
				'token-team', ?, ?, 'team token', 'hash', '[]',
				3600, ?, ?, 'test', ?, ?
			)`,
		)
		.bind(memberId, orgId, ts, ts, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO api_tokens (
				id, user_id, org_id, name, token_hash, scopes_json,
				idle_ttl_seconds, expires_at, max_expires_at, created_via,
				created_at, updated_at
			) VALUES (
				'token-other', ?, 'other-org', 'other token', 'hash2', '[]',
				3600, ?, ?, 'test', ?, ?
			)`,
		)
		.bind(memberId, ts, ts, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO cli_credential_bootstrap_codes (
				id, user_id, org_id, code_hash, name, scopes_json,
				idle_ttl_seconds, max_lifetime_seconds, expires_at, created_at
			) VALUES (
				'boot-team', ?, ?, 'codehash', 'boot', '[]',
				3600, 86400, ?, ?
			)`,
		)
		.bind(memberId, orgId, ts, ts)
		.run()

	const deleted = await softDeleteOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now,
	})
	const teamToken = await appDb
		.prepare(
			`SELECT revoked_at, deleted_at FROM api_tokens WHERE id = 'token-team'`,
		)
		.first<{ revoked_at: string | null; deleted_at: string | null }>()
	expect(teamToken?.revoked_at).toBe(deleted.deletedAt)
	expect(teamToken?.deleted_at).toBe(deleted.deletedAt)
	const otherToken = await appDb
		.prepare(
			`SELECT revoked_at, deleted_at FROM api_tokens WHERE id = 'token-other'`,
		)
		.first<{ revoked_at: string | null; deleted_at: string | null }>()
	expect(otherToken?.revoked_at).toBeNull()
	expect(otherToken?.deleted_at).toBeNull()
	const boot = await appDb
		.prepare(
			`SELECT COUNT(*) AS n FROM cli_credential_bootstrap_codes WHERE id = 'boot-team'`,
		)
		.first<{ n: number }>()
	expect(boot?.n).toBe(0)
})

test('resourceRestore clears one org-owned row while the org is still soft-deleted', async () => {
	const { env, appDb } = await createHarness()
	const orgId = 'org-resource-restore'
	await seedOrg(appDb, orgId, 'resource-restore')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, subject, summary, created_at, updated_at
			) VALUES ('mem-1', ?, 'demo', 'summary', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	const deleted = await softDeleteOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now,
	})
	const before = await appDb
		.prepare(`SELECT deleted_at FROM mcp_memories WHERE id = 'mem-1'`)
		.first<{ deleted_at: string | null }>()
	expect(before?.deleted_at).toBe(deleted.deletedAt)
	const result = await restoreResourceRow({
		env,
		orgId,
		resourceType: 'memory',
		resourceId: 'mem-1',
		now: new Date(now.getTime() + 60_000),
	})
	expect(result.restored).toBe(true)
	const after = await appDb
		.prepare(`SELECT deleted_at FROM mcp_memories WHERE id = 'mem-1'`)
		.first<{ deleted_at: string | null }>()
	expect(after?.deleted_at).toBeNull()
	const orgStillDeleted = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind(orgId)
		.first<{ deleted_at: string | null }>()
	expect(orgStillDeleted?.deleted_at).toBe(deleted.deletedAt)
})

test('org restore does not revive memberships for soft-deleted users', async () => {
	const { env, appDb } = await createHarness()
	const orgId = 'org-restore-members'
	const liveMember = 'live-member-1'
	const deletedMember = 'deleted-member-1'
	await seedOrg(appDb, orgId, 'restore-members')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO users (
				id, email, username, password_hash, created_at, updated_at, stable_user_id
			) VALUES
				(1, 'live@example.com', 'live', 'x', ?, ?, ?),
				(2, 'gone@example.com', 'gone', 'x', ?, ?, ?)`,
		)
		.bind(ts, ts, liveMember, ts, ts, deletedMember)
		.run()
	await appDb
		.prepare(`UPDATE users SET deleted_at = ? WHERE stable_user_id = ?`)
		.bind(ts, deletedMember)
		.run()
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?), (?, ?, 'member', ?)`,
		)
		.bind(orgId, liveMember, ts, orgId, deletedMember, ts)
		.run()
	const deleted = await softDeleteOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now,
	})
	await restoreOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now: new Date(now.getTime() + 60_000),
	})
	const live = await appDb
		.prepare(
			`SELECT deleted_at FROM org_memberships WHERE org_id = ? AND user_id = ?`,
		)
		.bind(orgId, liveMember)
		.first<{ deleted_at: string | null }>()
	expect(live?.deleted_at).toBeNull()
	const gone = await appDb
		.prepare(
			`SELECT deleted_at FROM org_memberships WHERE org_id = ? AND user_id = ?`,
		)
		.bind(orgId, deletedMember)
		.first<{ deleted_at: string | null }>()
	expect(gone?.deleted_at).toBe(deleted.deletedAt)
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
