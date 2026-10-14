import { DatabaseSync } from 'node:sqlite'
import {
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createInMemoryUserMeterEnv,
	createPermissiveAccountWriteLeaseDbHooks,
} from '#worker/test-support/user-meter.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { legacyOrgMemoryProvenanceUri } from './memory-owner.ts'
import { runMemoryPersonalizeCopy } from './memory-personalize.ts'
import { runMemoryPersonalizePurge } from './memory-personalize-purge.ts'

vi.mock('#worker/entitlements/service.ts', () => ({
	assertWithinStorageBytesEntitlement: vi.fn(async () => undefined),
	estimateEntitlementStorageEntryByteDelta: () => 1,
}))

vi.mock('./memory-vectorize.ts', () => ({
	upsertMemoryVector: vi.fn(async () => undefined),
	deleteMemoryVector: vi.fn(async () => undefined),
}))

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	const writeLease = createPermissiveAccountWriteLeaseDbHooks()
	const originalPrepare = db.prepare.bind(db)
	db.prepare = ((query: string) => {
		if (writeLease.supportsDeletingAtQuery(query)) {
			return {
				bind: () => ({
					first: async () => writeLease.deletingAtFirstResult(),
					all: async () => ({ results: [] }),
					run: async () => ({ meta: { changes: 0 } }),
				}),
			}
		}
		return originalPrepare(query)
	}) as typeof db.prepare
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db, columns: ['avatar_key'] })
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS mcp_memories (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			category TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			subject TEXT NOT NULL,
			summary TEXT NOT NULL,
			details TEXT NOT NULL DEFAULT '',
			tags_json TEXT NOT NULL DEFAULT '[]',
			source_uris_json TEXT NOT NULL DEFAULT '[]',
			dedupe_key TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_accessed_at TEXT,
			deleted_at TEXT
		);
		CREATE TABLE IF NOT EXISTS grants (
			id TEXT PRIMARY KEY NOT NULL,
			org_id TEXT NOT NULL,
			resource_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			subject_type TEXT NOT NULL,
			subject_id TEXT NOT NULL,
			preset TEXT,
			created_by_user_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			deleted_at TEXT
		);
		CREATE TABLE IF NOT EXISTS grant_permissions (
			grant_id TEXT NOT NULL,
			permission TEXT NOT NULL,
			PRIMARY KEY (grant_id, permission)
		);
	`)
	return { db, sqlite }
}

function insertUser(
	sqlite: DatabaseSync,
	input: { id: number; username: string; email: string; personId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (?, ?, ?, 'x', ?)`,
		)
		.run(input.id, input.username, input.email, input.personId)
}

test('runMemoryPersonalizePurge blocks when a reader is missing a personal copy', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-block@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-block',
		email: 'ada-purge-block@example.com',
		personId: ada,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-block',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-block-co',
		displayName: 'Purge Block',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-block-co'`)
		.first<{ id: string }>()
	const memoryId = 'mem-block-1'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Keep me', 'No copy yet', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(memoryId, org!.id)

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const result = await runMemoryPersonalizePurge({
		env,
		audit: createTestOrgAuditWriter(),
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(result.blockedMissingCopy).toBe(1)
	expect(result.purged).toBe(0)
	expect(result.rows[0]?.outcome).toBe('blocked_missing_copy')
	expect(result.rows[0]?.provenanceUrisChecked).toEqual([
		legacyOrgMemoryProvenanceUri(org!.id, memoryId),
	])
	const stillLive = await db
		.prepare(`SELECT deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`)
		.bind(memoryId, org!.id)
		.first<{ deleted_at: string | null }>()
	expect(stillLive?.deleted_at).toBeNull()
})

test('runMemoryPersonalizePurge soft-deletes only after copy, and revokes memory grants', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-ok@example.com')
	const guest = testStableUserIdFromEmail('guest-purge-ok@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-ok',
		email: 'ada-purge-ok@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'guest-purge-ok',
		email: 'guest-purge-ok@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-ok',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guest,
		username: 'guest-purge-ok',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-ok-co',
		displayName: 'Purge Ok',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-ok-co'`)
		.first<{ id: string }>()
	const memoryId = 'mem-purge-1'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Ship Mondays', 'Prefer Monday ships', 'detail', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(memoryId, org!.id)
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				created_by_user_id, created_at, updated_at
			) VALUES ('g-purge-1', ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(org!.id, memoryId, guest, ada)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('g-purge-1', 'memory:read')`,
		)
		.run()

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const audit = createTestOrgAuditWriter()

	const copied = await runMemoryPersonalizeCopy({
		env,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(copied.copied).toBeGreaterThanOrEqual(2)
	expect(copied.warnings).toEqual([])

	const dry = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: true,
		orgIds: [org!.id],
	})
	expect(dry.blockedMissingCopy).toBe(0)
	expect(dry.wouldPurge).toBe(1)
	expect(dry.grantsWouldRevoke).toBe(1)
	expect(dry.rows[0]?.verifiedCopyCount).toBe(2)
	expect(dry.rows[0]?.provenanceUrisChecked[0]).toBe(
		legacyOrgMemoryProvenanceUri(org!.id, memoryId),
	)

	const applied = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(applied.purged).toBe(1)
	expect(applied.grantsRevoked).toBe(1)
	expect(applied.blockedMissingCopy).toBe(0)

	const teamRow = await db
		.prepare(
			`SELECT status, deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`,
		)
		.bind(memoryId, org!.id)
		.first<{ status: string; deleted_at: string | null }>()
	expect(teamRow?.status).toBe('deleted')
	expect(teamRow?.deleted_at).toBeTruthy()

	const grant = await db
		.prepare(`SELECT deleted_at FROM grants WHERE id = 'g-purge-1'`)
		.first<{ deleted_at: string | null }>()
	expect(grant?.deleted_at).toBeTruthy()

	const personalAda = personalOrgId(personIdFromStored(ada))
	const personalGuest = personalOrgId(personIdFromStored(guest))
	const adaCopy = await db
		.prepare(
			`SELECT deleted_at, source_uris_json FROM mcp_memories
			 WHERE user_id = ? AND source_uris_json LIKE ?`,
		)
		.bind(personalAda, `%${legacyOrgMemoryProvenanceUri(org!.id, memoryId)}%`)
		.first<{ deleted_at: string | null; source_uris_json: string }>()
	const guestCopy = await db
		.prepare(
			`SELECT deleted_at FROM mcp_memories
			 WHERE user_id = ? AND source_uris_json LIKE ?`,
		)
		.bind(personalGuest, `%${legacyOrgMemoryProvenanceUri(org!.id, memoryId)}%`)
		.first<{ deleted_at: string | null }>()
	expect(adaCopy?.deleted_at).toBeNull()
	expect(guestCopy?.deleted_at).toBeNull()
	expect(adaCopy?.source_uris_json).toContain(
		legacyOrgMemoryProvenanceUri(org!.id, memoryId),
	)

	const again = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(again.scannedMemories).toBe(0)
	expect(again.purged).toBe(0)
})
