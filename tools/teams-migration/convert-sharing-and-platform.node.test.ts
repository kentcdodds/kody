import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	generateSealKeyPair,
	importRecipientPublicKey,
	openSealedJson,
} from '../preview-rehearsal/seal.ts'
import {
	conversionChecks,
	kodyCreditMicroUsd,
	kodyCreditNote,
	repairConversion,
	sealPreConversionBackup,
	verifyConversion,
	type ConversionReport,
	type PreConversionBackup,
} from './convert-sharing-and-platform.ts'
import { parseQueryTarget } from './production-queries.ts'

const migrationsDirectory = new URL(
	'../../packages/worker/migrations/',
	import.meta.url,
)
const conversionSql = readFileSync(
	new URL('0091-teams-sharing-platform-conversion.sql', migrationsDirectory),
	'utf8',
)

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	return sqlite
}

function seedUsersAndOrgs(sqlite: DatabaseSync) {
	const users = [
		[1, 'kody', 'kody-id', 'platform'],
		[2, 'tools', 'tools-id', 'platform'],
		[3, 'alice', 'alice-id', 'person'],
		[4, 'bob', 'bob-id', 'person'],
		[5, 'carol', 'carol-id', 'person'],
		[6, 'dave', 'dave-id', 'person'],
	] as const
	for (const [id, username, stableUserId, accountType] of users) {
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id, account_type)
				VALUES (?, ?, ?, 'secret-hash', '2026-10-01', '2026-10-01', ?, ?)`,
			)
			.run(id, username, `${username}@example.com`, stableUserId, accountType)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, ?, '2026-10-01', '2026-10-01')`,
			)
			.run(stableUserId, username)
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', '2026-10-01')`,
			)
			.run(stableUserId, stableUserId)
	}
}

function seedSharing(sqlite: DatabaseSync) {
	for (const packageId of ['alice-pkg-1', 'alice-pkg-2', 'alice-pkg-3']) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id, is_private, hidden)
				VALUES (?, 'alice-id', ?, ?, 'pkg', ?, 1, 0)`,
			)
			.run(packageId, packageId, packageId, `src-${packageId}`)
	}
	const share = (
		id: string,
		packageId: string,
		status: string,
		fields: {
			email?: string
			username?: string
			grantee?: string
		},
	) =>
		sqlite
			.prepare(
				`INSERT INTO package_share_grants
					(id, package_id, owner_user_id, invitee_email, invitee_username, grantee_user_id, status, invited_at, accepted_at, updated_at)
				VALUES (?, ?, 'alice-id', ?, ?, ?, ?, '2026-09-01T00:00:00.000Z', ?, '2026-09-02')`,
			)
			.run(
				id,
				packageId,
				fields.email ?? null,
				fields.username ?? null,
				fields.grantee ?? null,
				status,
				status === 'accepted' ? '2026-09-03T00:00:00.000Z' : null,
			)
	share('acc-bob', 'alice-pkg-1', 'accepted', { grantee: 'bob-id' })
	share('acc-carol', 'alice-pkg-2', 'accepted', { grantee: 'carol-id' })
	// Already covered by a live grant: no second grant.
	share('acc-carol-covered', 'alice-pkg-3', 'accepted', {
		grantee: 'carol-id',
	})
	// The package no longer exists: cannot become a grant.
	share('acc-orphan', 'missing-package', 'accepted', { grantee: 'bob-id' })
	share('pend-email', 'alice-pkg-2', 'pending', {
		email: ' Frank@Example.com ',
	})
	share('pend-username', 'alice-pkg-3', 'pending', {
		username: 'Erin',
		grantee: 'dave-id',
	})
	// Only the grantee is known: the invite matches their username.
	share('pend-grantee', 'alice-pkg-1', 'pending', { grantee: 'dave-id' })
	// Already invited: no second invite.
	share('pend-covered', 'alice-pkg-1', 'pending', {
		email: 'gina@example.com',
	})
	share('revoked', 'alice-pkg-1', 'revoked', { grantee: 'carol-id' })
	share('left', 'alice-pkg-3', 'left', { grantee: 'bob-id' })

	sqlite
		.prepare(
			`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type, subject_id, preset, created_by_user_id, created_at, updated_at)
			VALUES ('existing-grant', 'alice-id', 'package', 'alice-pkg-3', 'user', 'carol-id', 'manage', 'alice-id', '2026-09-01', '2026-09-01')`,
		)
		.run()
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES
				('existing-grant', 'package:read'), ('existing-grant', 'package:execute'), ('existing-grant', 'package:publish')`,
		)
		.run()
	sqlite
		.prepare(
			`INSERT INTO invites (id, org_id, kind, resource_type, resource_id, preset, invitee_email, token_hash, status, invited_by_user_id, expires_at, created_at)
			VALUES ('existing-invite', 'alice-id', 'grant', 'package', 'alice-pkg-1', 'use', 'gina@example.com', 'existing-token-hash', 'pending', 'alice-id', '2099-01-01', '2026-09-01')`,
		)
		.run()

	sqlite
		.prepare(
			`INSERT INTO package_scope_grants (scope_owner_user_id, grantee_user_id, created_by_user_id) VALUES
				('kody-id', 'alice-id', 'kody-id'), ('kody-id', 'bob-id', 'kody-id')`,
		)
		.run()
	// A grantee who was removed as a member earlier comes back as Owner.
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at)
			VALUES ('kody-id', 'bob-id', 'member', '2026-09-01', '2026-09-02')`,
		)
		.run()
}

function createSeededDb() {
	const sqlite = createMigratedDb()
	seedUsersAndOrgs(sqlite)
	seedSharing(sqlite)
	return sqlite
}

function rows<Row>(sqlite: DatabaseSync, sql: string) {
	return sqlite.prepare(sql).all() as Array<Row>
}

function scalar(sqlite: DatabaseSync, sql: string) {
	const row = sqlite.prepare(sql).get() as Record<string, unknown>
	return Object.values(row)[0]
}

function snapshot(sqlite: DatabaseSync) {
	return {
		grants: rows(sqlite, `SELECT * FROM grants ORDER BY id`),
		permissions: rows(
			sqlite,
			`SELECT * FROM grant_permissions ORDER BY grant_id, permission`,
		),
		invites: rows(sqlite, `SELECT id, status FROM invites ORDER BY id`),
		memberships: rows(
			sqlite,
			`SELECT org_id, user_id, role, deleted_at FROM org_memberships ORDER BY org_id, user_id`,
		),
		ledger: rows(sqlite, `SELECT * FROM credit_ledger_entries ORDER BY id`),
		wallets: rows(
			sqlite,
			`SELECT user_id, balance_micro_usd FROM credit_wallets`,
		),
	}
}

function createFakeCloudflare(sqlite: DatabaseSync) {
	const querySql: Array<string> = []
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		const path = url.pathname.replace(/^.*\/accounts\/acct/, '')
		if (path === '/d1/database' && method === 'GET') {
			return Response.json({
				success: true,
				result: [{ name: url.searchParams.get('name'), uuid: 'app-uuid' }],
			})
		}
		if (path === '/d1/database/app-uuid/query' && method === 'POST') {
			const body = JSON.parse(String(init?.body)) as { sql: string }
			querySql.push(body.sql)
			return Response.json({
				success: true,
				result: [{ results: sqlite.prepare(body.sql).all(), success: true }],
			})
		}
		throw new Error(`Unexpected Cloudflare request ${method} ${path}`)
	}
	return {
		querySql,
		client: { accountId: 'acct', apiToken: 'token', fetcher },
	}
}

const now = () => new Date('2026-10-10T00:00:00.000Z')

function failingChecks(report: ConversionReport) {
	return report.checks
		.filter((check) => check.gaps > 0)
		.map((check) => check.name)
}

test('0091 converts shares, scope grants, and platform accounts', () => {
	const sqlite = createSeededDb()
	sqlite.exec(conversionSql)

	const grants = rows<{
		id: string
		org_id: string
		resource_id: string
		subject_id: string
		preset: string
		created_by_user_id: string
		deleted_at: string | null
	}>(sqlite, `SELECT * FROM grants ORDER BY id`)
	expect(
		grants.map((grant) => [
			grant.id,
			grant.org_id,
			grant.resource_id,
			grant.subject_id,
			grant.preset,
			grant.deleted_at,
		]),
	).toEqual([
		['existing-grant', 'alice-id', 'alice-pkg-3', 'carol-id', 'manage', null],
		['p8-share-acc-bob', 'alice-id', 'alice-pkg-1', 'bob-id', 'use', null],
		['p8-share-acc-carol', 'alice-id', 'alice-pkg-2', 'carol-id', 'use', null],
	])
	expect(
		rows(
			sqlite,
			`SELECT grant_id, permission FROM grant_permissions WHERE grant_id LIKE 'p8-share-%' ORDER BY grant_id, permission`,
		),
	).toEqual([
		{ grant_id: 'p8-share-acc-bob', permission: 'package:execute' },
		{ grant_id: 'p8-share-acc-bob', permission: 'package:read' },
		{ grant_id: 'p8-share-acc-carol', permission: 'package:execute' },
		{ grant_id: 'p8-share-acc-carol', permission: 'package:read' },
	])

	const invites = rows<{
		id: string
		kind: string
		preset: string
		resource_type: string
		resource_id: string
		invitee_email: string | null
		invitee_username: string | null
		token_hash: string
		status: string
		invited_by_user_id: string
		expires_at: string
	}>(sqlite, `SELECT * FROM invites WHERE id LIKE 'p8-share-%' ORDER BY id`)
	expect(
		invites.map((invite) => [
			invite.id,
			invite.kind,
			invite.preset,
			invite.resource_type,
			invite.resource_id,
			invite.invitee_email,
			invite.invitee_username,
			invite.status,
			invite.invited_by_user_id,
		]),
	).toEqual([
		[
			'p8-share-pend-email',
			'grant',
			'use',
			'package',
			'alice-pkg-2',
			'frank@example.com',
			null,
			'pending',
			'alice-id',
		],
		[
			'p8-share-pend-grantee',
			'grant',
			'use',
			'package',
			'alice-pkg-1',
			null,
			'dave',
			'pending',
			'alice-id',
		],
		[
			'p8-share-pend-username',
			'grant',
			'use',
			'package',
			'alice-pkg-3',
			null,
			'erin',
			'pending',
			'alice-id',
		],
	])
	for (const invite of invites) {
		expect(invite.token_hash).toMatch(/^[0-9a-f]{64}$/)
		expect(Date.parse(invite.expires_at)).toBeGreaterThan(Date.now())
	}
	expect(new Set(invites.map((invite) => invite.token_hash)).size).toBe(3)
	expect(scalar(sqlite, `SELECT COUNT(*) FROM invites`)).toBe(4)

	// Revoked, left, and orphaned shares stay untouched for the P9 drop.
	expect(scalar(sqlite, `SELECT COUNT(*) FROM package_share_grants`)).toBe(10)

	expect(
		rows(
			sqlite,
			`SELECT org_id, user_id, role, deleted_at FROM org_memberships WHERE org_id = 'kody-id' ORDER BY user_id`,
		),
	).toEqual([
		{ org_id: 'kody-id', user_id: 'alice-id', role: 'owner', deleted_at: null },
		{ org_id: 'kody-id', user_id: 'bob-id', role: 'owner', deleted_at: null },
		{ org_id: 'kody-id', user_id: 'kody-id', role: 'owner', deleted_at: null },
	])

	expect(
		rows(
			sqlite,
			`SELECT id, plan, admin_credits_eligible FROM orgs ORDER BY id`,
		),
	).toEqual([
		{ id: 'alice-id', plan: 'free', admin_credits_eligible: 0 },
		{ id: 'bob-id', plan: 'free', admin_credits_eligible: 0 },
		{ id: 'carol-id', plan: 'free', admin_credits_eligible: 0 },
		{ id: 'dave-id', plan: 'free', admin_credits_eligible: 0 },
		{ id: 'kody-id', plan: 'pro', admin_credits_eligible: 1 },
		{ id: 'tools-id', plan: 'pro', admin_credits_eligible: 1 },
	])
	expect(
		rows(
			sqlite,
			`SELECT id, access_epoch FROM orgs WHERE access_epoch > 0 ORDER BY id`,
		),
	).toEqual([
		{ id: 'alice-id', access_epoch: 1 },
		{ id: 'kody-id', access_epoch: 1 },
	])

	expect(
		rows(
			sqlite,
			`SELECT user_id, kind, amount_micro_usd, granted_by_user_id, note FROM credit_ledger_entries`,
		),
	).toEqual([
		{
			user_id: 'kody-id',
			kind: 'admin_grant',
			amount_micro_usd: kodyCreditMicroUsd,
			granted_by_user_id: null,
			note: kodyCreditNote,
		},
	])
	expect(
		rows(sqlite, `SELECT user_id, balance_micro_usd FROM credit_wallets`),
	).toEqual([{ user_id: 'kody-id', balance_micro_usd: kodyCreditMicroUsd }])
})

test('0091 is idempotent: a second apply changes no rows and never double-credits', () => {
	const sqlite = createSeededDb()
	sqlite.exec(conversionSql)
	const before = snapshot(sqlite)
	sqlite.exec(conversionSql)
	const after = snapshot(sqlite)
	expect(after.invites.length).toBe(before.invites.length)
	expect(after).toEqual(before)
	expect(scalar(sqlite, `SELECT balance_micro_usd FROM credit_wallets`)).toBe(
		kodyCreditMicroUsd,
	)
})

test('0091 adds to an existing @kody wallet balance once', () => {
	const sqlite = createSeededDb()
	sqlite
		.prepare(
			`INSERT INTO credit_wallets (user_id, balance_micro_usd, created_at, updated_at) VALUES ('kody-id', 5000, '2026-10-01', '2026-10-01')`,
		)
		.run()
	sqlite.exec(conversionSql)
	sqlite.exec(conversionSql)
	expect(scalar(sqlite, `SELECT balance_micro_usd FROM credit_wallets`)).toBe(
		kodyCreditMicroUsd + 5000,
	)
})

test('0091 credits nobody when there is no platform @kody account', () => {
	const sqlite = createMigratedDb()
	seedUsersAndOrgs(sqlite)
	sqlite
		.prepare(`UPDATE users SET account_type = 'person' WHERE username = 'kody'`)
		.run()
	sqlite.exec(conversionSql)
	expect(scalar(sqlite, `SELECT COUNT(*) FROM credit_ledger_entries`)).toBe(0)
	expect(scalar(sqlite, `SELECT COUNT(*) FROM credit_wallets`)).toBe(0)
	expect(scalar(sqlite, `SELECT plan FROM orgs WHERE id = 'kody-id'`)).toBe(
		'free',
	)
	expect(scalar(sqlite, `SELECT plan FROM orgs WHERE id = 'tools-id'`)).toBe(
		'pro',
	)
})

test('0091 aborts when an accepted share is covered only by a narrower grant', () => {
	const sqlite = createSeededDb()
	sqlite
		.prepare(
			`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type, subject_id, preset, created_by_user_id, created_at, updated_at)
			VALUES ('narrow-grant', 'alice-id', 'package', 'alice-pkg-1', 'user', 'bob-id', NULL, 'alice-id', '2026-09-01', '2026-09-01')`,
		)
		.run()
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('narrow-grant', 'package:read')`,
		)
		.run()
	expect(() => sqlite.exec(conversionSql)).toThrow(/CHECK constraint failed/)
})

test('verifyConversion passes on a converted database with read-only queries', async () => {
	const sqlite = createSeededDb()
	sqlite.exec(conversionSql)
	const cloudflare = createFakeCloudflare(sqlite)
	const before = snapshot(sqlite)

	const report = await verifyConversion({
		client: cloudflare.client,
		target: parseQueryTarget('production'),
		now,
	})

	expect(report.ok).toBe(true)
	expect(report.target).toBe('production')
	expect(report.checks.map((check) => check.name)).toEqual(
		conversionChecks.map((check) => check.name),
	)
	expect(report.counts).toEqual({
		acceptedShares: 3,
		pendingShares: 4,
		scopeGrantees: 2,
		platformAccounts: 2,
		kodyBalanceMicroUsd: kodyCreditMicroUsd,
	})
	expect(snapshot(sqlite)).toEqual(before)
	for (const sql of cloudflare.querySql) {
		expect(sql).toMatch(/^SELECT/)
	}
})

test('verifyConversion names every gap before conversion has run', async () => {
	const sqlite = createSeededDb()
	const cloudflare = createFakeCloudflare(sqlite)
	const report = await verifyConversion({
		client: cloudflare.client,
		target: parseQueryTarget('production'),
		now,
	})
	expect(report.ok).toBe(false)
	expect(failingChecks(report)).toEqual([
		'accepted-share-use-grant',
		'pending-share-grant-invite',
		'scope-grantee-owner-membership',
		'platform-org-pro',
		'kody-site-admin-credit',
		'kody-wallet',
	])
})

test('repairConversion restores lost memberships, platform plans, and the @kody credit', async () => {
	const sqlite = createSeededDb()
	sqlite.exec(conversionSql)
	sqlite
		.prepare(
			`DELETE FROM org_memberships WHERE org_id = 'kody-id' AND user_id = 'alice-id'`,
		)
		.run()
	sqlite
		.prepare(
			`UPDATE org_memberships SET role = 'member' WHERE org_id = 'kody-id' AND user_id = 'bob-id'`,
		)
		.run()
	sqlite
		.prepare(
			`UPDATE orgs SET plan = 'free', admin_credits_eligible = 0 WHERE id = 'tools-id'`,
		)
		.run()
	sqlite.prepare(`DELETE FROM credit_ledger_entries`).run()
	sqlite.prepare(`DELETE FROM credit_wallets`).run()
	const cloudflare = createFakeCloudflare(sqlite)
	const target = parseQueryTarget('production')

	const broken = await verifyConversion({
		client: cloudflare.client,
		target,
		now,
	})
	expect(failingChecks(broken)).toEqual([
		'scope-grantee-owner-membership',
		'platform-org-pro',
		'kody-site-admin-credit',
		'kody-wallet',
	])

	const repaired = await repairConversion({
		client: cloudflare.client,
		target,
		now,
	})
	expect(repaired.ok).toBe(true)
	expect(repaired.counts.kodyBalanceMicroUsd).toBe(kodyCreditMicroUsd)

	const afterRepair = snapshot(sqlite)
	const second = await repairConversion({
		client: cloudflare.client,
		target,
		now,
	})
	expect(second.ok).toBe(true)
	expect(snapshot(sqlite)).toEqual(afterRepair)
	expect(scalar(sqlite, `SELECT balance_micro_usd FROM credit_wallets`)).toBe(
		kodyCreditMicroUsd,
	)
})

test('repair does not restore lost share grants', async () => {
	const sqlite = createSeededDb()
	sqlite.exec(conversionSql)
	sqlite.prepare(`DELETE FROM grants WHERE id = 'p8-share-acc-bob'`).run()
	const cloudflare = createFakeCloudflare(sqlite)
	const report = await repairConversion({
		client: cloudflare.client,
		target: parseQueryTarget('production'),
		now,
	})
	expect(failingChecks(report)).toEqual(['accepted-share-use-grant'])
})

test('sealPreConversionBackup seals the share, scope, and platform rows without password hashes', async () => {
	const sqlite = createSeededDb()
	const cloudflare = createFakeCloudflare(sqlite)
	const keys = await generateSealKeyPair()

	const envelope = await sealPreConversionBackup({
		client: cloudflare.client,
		target: parseQueryTarget('production'),
		recipientPublicKey: await importRecipientPublicKey(keys.publicKey),
		now,
	})

	expect(JSON.stringify(envelope)).not.toContain('alice')
	const backup = (await openSealedJson(
		envelope,
		keys.privateKey,
	)) as PreConversionBackup
	expect(backup.takenAt).toBe('2026-10-10T00:00:00.000Z')
	expect(backup.packageShareGrants).toHaveLength(10)
	expect(backup.packageScopeGrants).toHaveLength(2)
	expect(backup.platformUsers.map((user) => user['username'])).toEqual([
		'kody',
		'tools',
	])
	expect(JSON.stringify(backup)).not.toContain('secret-hash')
	for (const sql of cloudflare.querySql) {
		expect(sql).toMatch(/^SELECT/)
	}
})
