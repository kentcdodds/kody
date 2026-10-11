import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test } from 'vitest'
import {
	assignUserRole,
	removeUserRole,
} from '#worker/identity/permissions-db.ts'
import {
	clearMcpAuthCacheForTests,
	mcpAuthCacheSizeForTests,
} from '#worker/mcp-auth-cache.ts'
import { buildMcpAuthContextCached } from '#worker/mcp-auth-user-context.ts'
import {
	addOrgMember,
	createOrg,
	updateOrgMemberRole,
} from '#worker/orgs/access-writes.ts'
import { offboardOrgMember } from '#worker/orgs/offboarding.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

beforeEach(() => {
	clearMcpAuthCacheForTests()
})

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../migrations/', import.meta.url))
	const inner = createD1FromSqlite(sqlite)
	const statements: Array<string> = []
	const db = new Proxy(inner, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (sql: string) => {
					statements.push(sql.replace(/\s+/g, ' ').trim())
					return target.prepare(sql)
				}
			}
			return Reflect.get(target, property, receiver)
		},
	}) as D1Database
	const env = { APP_DB: db } as Env

	async function seedUser(id: number, username: string) {
		const email = `${username}@example.com`
		const stableUserId = testStableUserIdFromEmail(email)
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
				 VALUES (?, ?, ?, ?, 'unused', '2026-01-01T00:00:00.000Z')`,
			)
			.run(id, username, email, stableUserId)
		await provisionPersonalOrg(db, { stableUserId, username })
		return { id, stableUserId, email }
	}
	const founder = await seedUser(1, 'founder')
	const owner = await seedUser(2, 'second-owner')
	const org = await createOrg({
		db,
		env: {} as Env,
		slug: 'rocket-co',
		createdByUserId: founder.stableUserId,
		audit: createTestOrgAuditWriter(),
	})
	await addOrgMember({
		db,
		orgId: org.id,
		userId: owner.stableUserId,
		role: 'owner',
		invitedByUserId: founder.stableUserId,
		audit: createTestOrgAuditWriter(),
	})
	statements.length = 0
	return { db, env, sqlite, statements, founder, owner, org }
}

function roundTripsSince(statements: Array<string>) {
	// Each D1 batch is one round trip; the loader only issues batches.
	return statements.filter((sql) => /^SELECT .*FROM users/i.test(sql)).length
}

test('a warm entry skips the roles and binding reads but a just-demoted owner is never served the stale role', async () => {
	const { env, statements, owner, org } = await setup()
	const grantProps = { userId: owner.stableUserId, orgId: org.id }
	const token = 'token-owner'

	const first = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(first?.orgBinding?.role).toBe('owner')
	expect(first?.orgBinding?.org.id).toBe(org.id)
	expect(mcpAuthCacheSizeForTests()).toBe(1)
	const missStatements = statements.length
	expect(statements.some((sql) => /FROM org_memberships/i.test(sql))).toBe(true)
	expect(statements.some((sql) => /FROM user_roles/i.test(sql))).toBe(true)

	statements.length = 0
	const second = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(second?.orgBinding?.role).toBe('owner')
	expect(roundTripsSince(statements)).toBe(1)
	expect(statements.length).toBeLessThan(missStatements)
	expect(statements.some((sql) => /FROM org_memberships/i.test(sql))).toBe(
		false,
	)
	expect(statements.some((sql) => /FROM user_roles/i.test(sql))).toBe(false)

	await updateOrgMemberRole({
		db: env.APP_DB,
		orgId: org.id,
		userId: owner.stableUserId,
		role: 'member',
		audit: createTestOrgAuditWriter(),
	})
	const demoted = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(demoted?.orgBinding?.role).toBe('member')

	// The recomputed entry is warm again and still correct.
	statements.length = 0
	const again = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(again?.orgBinding?.role).toBe('member')
	expect(statements.some((sql) => /FROM org_memberships/i.test(sql))).toBe(
		false,
	)
})

test('a just-removed owner loses the org binding on the very next request with the same token', async () => {
	const { env, owner, org } = await setup()
	const grantProps = { userId: owner.stableUserId, orgId: org.id }
	const token = 'token-removed-owner'

	const warm = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(warm?.orgBinding?.role).toBe('owner')

	const result = await offboardOrgMember({
		appDb: env.APP_DB,
		env,
		orgId: ownerIdFromStored(String(org.id)),
		memberUserId: owner.stableUserId,
		memberLeftVoluntarily: false,
	})
	expect(result.membershipSoftDeleted).toBe(true)

	const removed = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(removed?.context.user.userId).toBe(owner.stableUserId)
	expect(removed?.orgBinding).toBeNull()
})

test('global role changes invalidate the cached roles immediately', async () => {
	const { env, owner } = await setup()
	const grantProps = { userId: owner.stableUserId }
	const token = 'token-roles'

	const before = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(before?.context.user.roles ?? []).not.toContain('admin')

	await assignUserRole({ db: env.APP_DB, userId: owner.id, roleName: 'admin' })
	const promoted = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(promoted?.context.user.roles).toContain('admin')

	await removeUserRole({ db: env.APP_DB, userId: owner.id, roleName: 'admin' })
	const demoted = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(demoted?.context.user.roles ?? []).not.toContain('admin')
})

test('suspension and deletion flags are read fresh on every request and evict the entry', async () => {
	const { env, sqlite, owner, org } = await setup()
	const grantProps = { userId: owner.stableUserId, orgId: org.id }
	const token = 'token-flags'

	const warm = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(warm?.context.suspended).toBe(false)

	sqlite
		.prepare(`UPDATE users SET suspended_at = ? WHERE id = ?`)
		.run('2026-10-11T00:00:00.000Z', owner.id)
	const suspended = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(suspended?.context.suspended).toBe(true)

	sqlite
		.prepare(`UPDATE users SET deleting_at = ? WHERE id = ?`)
		.run('2026-10-11T00:00:01.000Z', owner.id)
	const deleting = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(deleting).toBeNull()
	expect(mcpAuthCacheSizeForTests()).toBe(0)
})

test('entries are keyed by token, so another token for the same user is derived on its own', async () => {
	const { env, statements, owner, org } = await setup()
	const grantProps = { userId: owner.stableUserId, orgId: org.id }

	await buildMcpAuthContextCached(env, { grantProps, accessToken: 'a' })
	statements.length = 0
	await buildMcpAuthContextCached(env, { grantProps, accessToken: 'b' })
	expect(statements.some((sql) => /FROM org_memberships/i.test(sql))).toBe(true)
	expect(mcpAuthCacheSizeForTests()).toBe(2)
})
