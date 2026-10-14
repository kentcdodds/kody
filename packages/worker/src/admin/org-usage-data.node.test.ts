import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { loadAdminOrgUsageData } from './org-usage-data.ts'

const personId = testStableUserIdFromEmail('owner@acme.example')
const teamOrgId = testStableUserIdFromEmail('team-org@acme.example')
const now = new Date('2026-08-15T12:00:00.000Z')

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	applyAllMigrations(
		sqlite,
		new URL('../../../jobs-worker/migrations/', import.meta.url),
	)
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, created_at, updated_at)
			 VALUES ('owner', 'owner@acme.example', 'hash', ?, '2026-01-01', '2026-01-01')`,
		)
		.run(personId)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, 'owner', 'free', '2026-01-01', '2026-01-01')`,
		)
		.run(personId)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, created_at, updated_at)
			 VALUES (?, 'acme', 'Acme', 'pro', '2026-01-01', '2026-01-01')`,
		)
		.run(teamOrgId)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('loadAdminOrgUsageData reads team-org counters by org id and slug (#3535)', async () => {
	const { db } = createDb()
	const meter = createInMemoryUserMeterEnv()
	const env = {
		...meter.env,
		...createInMemoryRunLogUsageEnv().env,
		...createInMemoryRepoSessionIndexEnv(db),
		MAILBOX: {
			idFromName: (userId: string) =>
				({ userId }) as unknown as DurableObjectId,
			get: () => ({ countMessages: async () => ({ total: 0 }) }),
		},
	} as unknown as Env

	const byId = await loadAdminOrgUsageData(env, { orgId: teamOrgId }, now)
	expect(byId).toMatchObject({
		ok: true,
		org: { id: teamOrgId, slug: 'acme', displayName: 'Acme' },
		plan: 'pro',
		currentMonth: '2026-08',
	})
	expect(byId?.entitlementConsumption.length).toBeGreaterThan(0)

	const bySlug = await loadAdminOrgUsageData(env, { org: '@acme' }, now)
	expect(bySlug?.org.id).toBe(teamOrgId)

	expect(
		await loadAdminOrgUsageData(env, { org: 'missing-org' }, now),
	).toBeNull()
})
