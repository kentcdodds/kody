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
const memberTwoId = testStableUserIdFromEmail('member2@acme.example')
const memberThreeId = testStableUserIdFromEmail('member3@acme.example')
const giftedOrgId = testStableUserIdFromEmail('gifted-org@acme.example')
const now = new Date('2026-08-15T12:00:00.000Z')
const proPriceId = 'price_pro'

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
			`INSERT INTO users (username, email, password_hash, stable_user_id, created_at, updated_at)
			 VALUES ('member2', 'member2@acme.example', 'hash', ?, '2026-01-01', '2026-01-01')`,
		)
		.run(memberTwoId)
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, created_at, updated_at)
			 VALUES ('member3', 'member3@acme.example', 'hash', ?, '2026-01-01', '2026-01-01')`,
		)
		.run(memberThreeId)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, 'owner', 'free', '2026-01-01', '2026-01-01')`,
		)
		.run(personId)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, stripe_plan, stripe_price_id, created_at, updated_at)
			 VALUES (?, 'acme', 'Acme', 'pro', 'pro', ?, '2026-01-01', '2026-01-01')`,
		)
		.run(teamOrgId, proPriceId)
	sqlite
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan,
				second_agent_standard_gift_granted_at,
				second_agent_standard_gift_expires_at,
				created_at, updated_at
			) VALUES (?, 'gifted', 'Gifted', 'free', ?, ?, '2026-01-01', '2026-01-01')`,
		)
		.run(giftedOrgId, '2026-08-01T00:00:00.000Z', '2026-08-29T00:00:00.000Z')
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', '2026-01-01'),
			        (?, ?, 'member', '2026-01-01'),
			        (?, ?, 'member', '2026-01-01')`,
		)
		.run(teamOrgId, personId, teamOrgId, memberTwoId, teamOrgId, memberThreeId)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createUsageEnv(db: D1Database) {
	const meter = createInMemoryUserMeterEnv()
	return {
		...meter.env,
		...createInMemoryRunLogUsageEnv().env,
		...createInMemoryRepoSessionIndexEnv(db),
		STRIPE_PRO_PRICE_ID: proPriceId,
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
		MAILBOX: {
			idFromName: (userId: string) =>
				({ userId }) as unknown as DurableObjectId,
			get: () => ({ countMessages: async () => ({ total: 0 }) }),
		},
	} as unknown as Env
}

test('loadAdminOrgUsageData reads team-org counters by org id and slug (#3535)', async () => {
	const { db } = createDb()
	const env = createUsageEnv(db)

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

test('loadAdminOrgUsageData returns null for 404 and propagates D1 failures', async () => {
	const { db } = createDb()
	const env = createUsageEnv(db)

	expect(
		await loadAdminOrgUsageData(env, { org: 'missing-org' }, now),
	).toBeNull()

	const failingDb = {
		prepare() {
			throw new Error('D1 unavailable')
		},
	} as unknown as D1Database
	await expect(
		loadAdminOrgUsageData({ ...env, APP_DB: failingDb }, { org: '@acme' }, now),
	).rejects.toThrow('D1 unavailable')
})

test('loadAdminOrgUsageData multiplies list MRR by live billed seats', async () => {
	const { db } = createDb()
	const env = createUsageEnv(db)

	const usage = await loadAdminOrgUsageData(env, { orgId: teamOrgId }, now)
	expect(usage?.costVsPay).toMatchObject({
		estimatedPaidUsdCents: 3_600,
		paidSource: 'stripe_catalog',
	})
})

test('loadAdminOrgUsageData scores inboundReceive against base plan under Pro overlay', async () => {
	const { db } = createDb()
	const env = createUsageEnv(db)

	const usage = await loadAdminOrgUsageData(env, { orgId: giftedOrgId }, now)
	expect(usage?.plan).toBe('pro')
	const receives = usage?.entitlementConsumption.find(
		(item) => item.resource === 'email_receives_per_day',
	)
	const packages = usage?.entitlementConsumption.find(
		(item) => item.resource === 'saved_packages',
	)
	expect(receives?.limit).toBe(10)
	expect(packages?.limit).toBe(200)
})
