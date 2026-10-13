import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { resolveOrgBindingForUserOwnedToken } from '#worker/open-api/authenticate.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	mintCliCredentialBootstrap,
	redeemCliCredentialBootstrap,
} from './cli-credential-bootstrap.ts'
import { apiTokenLifetimeAliases, mintApiToken } from './service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const start = new Date('2026-10-12T12:00:00.000Z')
const shortLife = apiTokenLifetimeAliases.short

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('mintApiToken defaults to org-bound; org_binding user is additive', async () => {
	const { db } = createDb()
	const userId = ownerIdFromStored(
		testStableUserIdFromEmail('mint@example.com'),
	)
	const orgBound = await mintApiToken({
		db,
		userId,
		name: 'org-bound',
		scopes: ['org:read', 'package:read'],
		idleTtlSeconds: shortLife.idleTtlSeconds,
		maxLifetimeSeconds: shortLife.maxLifetimeSeconds,
		createdVia: 'api',
		orgId: userId,
		now: start,
	})
	expect(orgBound.org_binding).toBe('org')
	expect(orgBound.org_id).toBe(userId)

	const userOwned = await mintApiToken({
		db,
		userId,
		name: 'user-owned',
		scopes: ['org:read', 'package:read'],
		idleTtlSeconds: shortLife.idleTtlSeconds,
		maxLifetimeSeconds: shortLife.maxLifetimeSeconds,
		createdVia: 'api',
		orgBinding: 'user',
		orgId: 'team-should-be-ignored',
		now: start,
	})
	expect(userOwned.org_binding).toBe('user')
	expect(userOwned.org_id).toBe(userId)
})

test('user-owned token org resolution: member, ex-member denied, grant-only', async () => {
	const { db } = createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const gus = testStableUserIdFromEmail('gus@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: start.toISOString(),
	})
	await provisionPersonalOrg(db, {
		stableUserId: gus,
		username: 'gus',
		createdAt: start.toISOString(),
	})

	// Ada is a member of Gus's personal org (treated as a "team" for the test).
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(gus, ada, start.toISOString())
		.run()

	const asMember = await resolveOrgBindingForUserOwnedToken({
		db,
		userId: ada,
		orgHint: 'gus',
	})
	expect(asMember?.org.id).toBe(gus)
	expect(asMember?.role).toBe('member')

	const personal = await resolveOrgBindingForUserOwnedToken({
		db,
		userId: ada,
		orgHint: null,
	})
	expect(personal?.org.id).toBe(ada)
	expect(personal?.role).toBe('owner')

	// Leave Gus's org — access fails immediately for the same user-owned token.
	await db
		.prepare(
			`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
		)
		.bind(start.toISOString(), gus, ada)
		.run()
	expect(
		await resolveOrgBindingForUserOwnedToken({
			db,
			userId: ada,
			orgHint: 'gus',
		}),
	).toBeNull()

	// Grant-only: Ada gets a live package grant in Gus's org without membership.
	await db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES (?, ?, 'package', 'pkg-1', 'user', ?, 'use', ?, ?, ?, NULL)`,
		)
		.bind('grant-1', gus, ada, gus, start.toISOString(), start.toISOString())
		.run()

	const grantOnly = await resolveOrgBindingForUserOwnedToken({
		db,
		userId: ada,
		orgHint: 'gus',
	})
	expect(grantOnly?.org.id).toBe(gus)
	expect(grantOnly?.role).toBeNull()
})

test('new CLI bootstrap redeem mints user-owned tokens; org-bound codes stay org', async () => {
	const { db, sqlite } = createDb()
	const userId = ownerIdFromStored(
		testStableUserIdFromEmail('bootstrap@example.com'),
	)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('boot', 'bootstrap-user@example.com', 'hash', ?)`,
		)
		.bind(userId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId: userId,
		username: 'boot',
		createdAt: start.toISOString(),
	})
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		lifetime: 'short',
		now: start,
	})
	const row = sqlite
		.prepare(`SELECT org_binding FROM cli_credential_bootstrap_codes LIMIT 1`)
		.get() as { org_binding: string }
	expect(row.org_binding).toBe('user')

	const redeemed = await redeemCliCredentialBootstrap({
		db,
		code: minted.bootstrap_code,
		lifetime: 'short',
		now: start,
	})
	expect(redeemed.token.org_binding).toBe('user')

	const orgCode = await mintCliCredentialBootstrap({
		db,
		userId,
		orgBinding: 'org',
		orgId: userId,
		lifetime: 'short',
		now: new Date(start.getTime() + 1000),
	})
	const orgRedeemed = await redeemCliCredentialBootstrap({
		db,
		code: orgCode.bootstrap_code,
		lifetime: 'short',
		now: new Date(start.getTime() + 1000),
	})
	expect(orgRedeemed.token.org_binding).toBe('org')
	expect(orgRedeemed.token.org_id).toBe(userId)
})
