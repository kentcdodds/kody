import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

vi.mock('#worker/jobs/manager-client.ts', () => ({
	purgeJobManagerForUser: vi.fn(async () => ({
		ok: true as const,
		userId: 'mock',
		purged: false,
	})),
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		purgeUserJobsData: vi.fn(async () => undefined),
	}),
}))

const { hardPurgeOrg } = await import('./hard-purge.ts')

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

test('hardPurgeOrg deletes org-owned children and the org graph from one inventory', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const orgId = 'org-hard-purge'
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, deleted_at,
				created_at, updated_at
			) VALUES (?, ?, ?, 'free', 'public', ?, ?, ?)`,
		)
		.bind(orgId, 'hard-purge', 'Hard purge', ts, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES ('sec-purge', ?, 'user', 'default', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_entries (
				bucket_id, name, encrypted_value, created_at, updated_at
			) VALUES ('sec-purge', 'api-key', 'cipher', ?, ?)`,
		)
		.bind(ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO teams (
				id, org_id, slug, name, created_by_user_id, created_at, updated_at
			) VALUES ('team-purge', ?, 'eng', 'Eng', 'owner-1', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at)
			 VALUES ('team-purge', 'member-1', ?)`,
		)
		.bind(ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at
			) VALUES (
				'grant-purge', ?, 'package', 'pkg-1', 'user', 'member-1',
				'use', 'owner-1', ?, ?
			)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 VALUES ('grant-purge', 'package:read')`,
		)
		.run()
	await appDb
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('hard-purge', ?, ?)`,
		)
		.bind(orgId, ts)
		.run()
	const otherOrgId = 'org-hard-purge-other'
	await appDb
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder,
				created_at, updated_at
			) VALUES (?, 'other-purge', 'Other', 'free', 'public', ?, ?)`,
		)
		.bind(otherOrgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES ('sec-other', ?, 'user', 'default', ?, ?)`,
		)
		.bind(otherOrgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_entries (
				bucket_id, name, encrypted_value, created_at, updated_at
			) VALUES ('sec-other', 'api-key', 'cipher', ?, ?)`,
		)
		.bind(ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO teams (
				id, org_id, slug, name, created_by_user_id, created_at, updated_at
			) VALUES ('team-other', ?, 'eng', 'Eng', 'owner-1', ?, ?)`,
		)
		.bind(otherOrgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at)
			 VALUES ('team-other', 'member-1', ?)`,
		)
		.bind(ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at
			) VALUES (
				'grant-other', ?, 'package', 'pkg-2', 'user', 'member-1',
				'use', 'owner-1', ?, ?
			)`,
		)
		.bind(otherOrgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 VALUES ('grant-other', 'package:read')`,
		)
		.run()
	await appDb
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('other-purge', ?, ?)`,
		)
		.bind(otherOrgId, ts)
		.run()

	await hardPurgeOrg({
		env: { APP_DB: appDb, AUDIT_DB: auditDb } as Env,
		orgId,
	})

	for (const [sql, label] of [
		[`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`, 'orgs'],
		[`SELECT COUNT(*) AS n FROM secret_buckets WHERE user_id = ?`, 'buckets'],
		[
			`SELECT COUNT(*) AS n FROM secret_entries WHERE bucket_id = 'sec-purge'`,
			'entries',
		],
		[`SELECT COUNT(*) AS n FROM teams WHERE org_id = ?`, 'teams'],
		[
			`SELECT COUNT(*) AS n FROM team_members WHERE team_id = 'team-purge'`,
			'members',
		],
		[`SELECT COUNT(*) AS n FROM grants WHERE org_id = ?`, 'grants'],
		[
			`SELECT COUNT(*) AS n FROM grant_permissions WHERE grant_id = 'grant-purge'`,
			'permissions',
		],
		[`SELECT COUNT(*) AS n FROM handles WHERE org_id = ?`, 'handles'],
	] as const) {
		const bindsId = sql.includes('?')
		const row = await appDb
			.prepare(sql)
			.bind(...(bindsId ? [orgId] : []))
			.first<{ n: number }>()
		expect({ label, n: row?.n }).toEqual({ label, n: 0 })
	}
	const audit = await auditDb
		.prepare(`SELECT action FROM org_audit_events WHERE org_id = ?`)
		.bind(orgId)
		.first<{ action: string }>()
	expect(audit?.action).toBe('org.purged')
	const otherStillThere = await appDb
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM orgs WHERE id = ?) AS orgs,
				(SELECT COUNT(*) FROM secret_buckets WHERE id = 'sec-other') AS buckets,
				(SELECT COUNT(*) FROM secret_entries WHERE bucket_id = 'sec-other') AS entries,
				(SELECT COUNT(*) FROM teams WHERE id = 'team-other') AS teams,
				(SELECT COUNT(*) FROM team_members WHERE team_id = 'team-other') AS members,
				(SELECT COUNT(*) FROM grants WHERE id = 'grant-other') AS grants,
				(SELECT COUNT(*) FROM grant_permissions WHERE grant_id = 'grant-other') AS permissions,
				(SELECT COUNT(*) FROM handles WHERE handle = 'other-purge') AS handles`,
		)
		.bind(otherOrgId)
		.first<{
			orgs: number
			buckets: number
			entries: number
			teams: number
			members: number
			grants: number
			permissions: number
			handles: number
		}>()
	expect(otherStillThere).toEqual({
		orgs: 1,
		buckets: 1,
		entries: 1,
		teams: 1,
		members: 1,
		grants: 1,
		permissions: 1,
		handles: 1,
	})
})
