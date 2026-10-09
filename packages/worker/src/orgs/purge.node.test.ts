import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const hardPurgeOrg = vi.fn(async (input: { env: Env; orgId: string }) => {
	await input.env.APP_DB.prepare(`DELETE FROM orgs WHERE id = ?`)
		.bind(input.orgId)
		.run()
	return { orgId: input.orgId, deletedTables: { orgs: 1 } }
})

vi.mock('./hard-purge.ts', () => ({
	hardPurgeOrg: (input: { env: Env; orgId: string }) => hardPurgeOrg(input),
	hardPurgeSoftDeletedUser: vi.fn(),
}))

const {
	listSoftDeletePurgeCandidates,
	pruneSoftDeleted,
	softDeletePurgeWritesEnabled,
} = await import('./purge.ts')

const now = new Date('2026-10-01T12:00:00.000Z')
const oldDeletedAt = '2025-08-01T00:00:00.000Z'

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

async function createEnv(purgeEnabled: boolean) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		SOFT_DELETE_PURGE_ENABLED: purgeEnabled ? 'true' : 'false',
	} as Env
	return { env, db }
}

async function seedSoftDeletedOrg(db: D1Database, orgId: string) {
	const ts = '2026-01-01T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, entitlement_ladder, deleted_at, created_at, updated_at)
			VALUES (?, ?, ?, 'free', 'public', ?, ?, ?)`,
		)
		.bind(orgId, orgId, orgId, oldDeletedAt, ts, oldDeletedAt)
		.run()
}

beforeEach(() => {
	hardPurgeOrg.mockClear()
})

test('purge dry-run lists old soft-deleted org', async () => {
	const { env, db } = await createEnv(false)
	await seedSoftDeletedOrg(db, 'org-purge-candidate')
	expect(softDeletePurgeWritesEnabled(env)).toBe(false)
	const preview = await listSoftDeletePurgeCandidates({ env, now })
	expect(
		preview.candidates.some(
			(c) => c.kind === 'org' && c.id === 'org-purge-candidate',
		),
	).toBe(true)
	const dryRun = await pruneSoftDeleted({ env, now, dryRun: true })
	expect(dryRun.purged).toBe(0)
	expect(dryRun.outcomes[0]?.outcome).toBe('would_purge')
	expect(hardPurgeOrg).not.toHaveBeenCalled()
	const stillThere = await db
		.prepare(`SELECT id FROM orgs WHERE id = ?`)
		.bind('org-purge-candidate')
		.first()
	expect(stillThere).toBeTruthy()
})

test('real purge with enabled flag hard-deletes idempotently', async () => {
	const { env, db } = await createEnv(true)
	await seedSoftDeletedOrg(db, 'org-purge-real')
	const first = await pruneSoftDeleted({ env, now, dryRun: false })
	expect(first.failed, JSON.stringify(first.outcomes)).toBe(0)
	expect(first.purged).toBe(1)
	expect(hardPurgeOrg).toHaveBeenCalled()
	const gone = await db
		.prepare(`SELECT id FROM orgs WHERE id = ?`)
		.bind('org-purge-real')
		.first()
	expect(gone).toBeNull()
	const second = await pruneSoftDeleted({ env, now, dryRun: false })
	expect(second.purged).toBe(0)
})
