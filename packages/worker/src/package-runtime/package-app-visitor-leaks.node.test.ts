/**
 * Package app visitor leak tests. Real boundaries: a migrated APP_DB with a
 * team org, real accounts and memberships, the real package app caller
 * context, the real runtime bridge and capability registry, and the real
 * `orgMemberUpdate` handler. The app's server code is the bridge call itself.
 */
import { DatabaseSync } from 'node:sqlite'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import { expect, test } from 'vitest'
import { orgMemberUpdateCapability } from '#mcp/capabilities/access/org-members.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	createPackageAppCallerContext,
	PackageAppRuntimeBridge,
} from './package-app.ts'

const now = '2026-10-11T00:00:00.000Z'
const baseUrl = 'https://kody.example'

async function insertAccount(
	db: D1Database,
	input: { email: string; username: string },
) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
			 VALUES (?, ?, 'test-password-hash', ?, ?)`,
		)
		.bind(input.username, input.email, now, stableUserId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId,
		username: input.username,
		createdAt: now,
	})
	return personIdFromStored(stableUserId)
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const ownerId = await insertAccount(db, {
		email: 'owner@acme.example',
		username: 'owner',
	})
	const beaId = await insertAccount(db, {
		email: 'bea@acme.example',
		username: 'bea',
	})
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: ownerId,
			audit: createTestOrgAuditWriter(),
			slug: 'quillworks',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const teamOrg = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'quillworks'`)
		.first<{ id: string }>()
	const orgId = ownerIdFromStored(teamOrg!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(orgId, beaId, now)
		.run()
	// Bea saved it, as a Member with package:create can.
	await db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES ('pkg-app', ?, '@quillworks/app', 'app', '', 'source-pkg-app')`,
		)
		.bind(orgId)
		.run()
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		APP_BASE_URL: baseUrl,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env

	const owner = {
		userId: orgId,
		username: 'quillworks',
		email: 'bea@acme.example',
		displayName: 'Bea',
	}
	const visitors = {
		owner: { userId: ownerId, username: 'owner', role: 'owner' },
		bea: { userId: beaId, username: 'bea', role: 'member' },
	} satisfies Record<string, RuntimePackageAppVisitor>

	const bridgeFor = (visitor: RuntimePackageAppVisitor | null) =>
		new PackageAppRuntimeBridge(
			{
				props: {
					baseUrl,
					userId: orgId,
					orgSlug: 'quillworks',
					visitor,
					email: owner.email,
					displayName: owner.displayName,
					packageId: 'pkg-app',
					kodyId: 'app',
					sourceId: 'source-pkg-app',
					publishedCommit: 'commit-1',
					packageStorageGrantIds: ['pkg-app'],
				},
				waitUntil: () => {},
			} as never,
			env,
		)

	const beasRole = async () =>
		(
			await db
				.prepare(
					`SELECT role FROM org_memberships
					 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
				)
				.bind(orgId, beaId)
				.first<{ role: string }>()
		)?.role

	return { env, orgId, owner, visitors, bridgeFor, beasRole }
}

const promoteBea = {
	name: 'orgMemberUpdate',
	args: { username: 'bea', role: 'owner' },
}

test("a member's package app acts as its visitor, so it cannot make them Owner", async () => {
	const t = await setup()

	const callerContext: McpCallerContext = await createPackageAppCallerContext({
		baseUrl,
		owner: t.owner,
		visitor: t.visitors.bea,
		packageId: 'pkg-app',
	})
	expect(callerContext.request).toMatchObject({
		org: { id: t.orgId, slug: 'quillworks' },
		actor: { userId: t.visitors.bea.userId },
		membership: { role: 'member' },
	})
	await expect(
		orgMemberUpdateCapability.handler(promoteBea.args as never, {
			env: t.env,
			callerContext,
		}),
	).rejects.toMatchObject({
		name: 'LivePersonRequiredError',
		capabilityName: 'orgMemberUpdate',
	})

	await expect(
		t.bridgeFor(t.visitors.bea).callCapability(promoteBea),
	).rejects.toThrow('"orgMemberUpdate" needs a live person')
	expect(await t.beasRole()).toBe('member')

	// Package code decides when an app calls, so even an Owner's visit is not a
	// live person for role changes.
	await expect(
		t.bridgeFor(t.visitors.owner).callCapability(promoteBea),
	).rejects.toThrow('"orgMemberUpdate" needs a live person')
	expect(await t.beasRole()).toBe('member')
})

test('an anonymous visitor of an internet-visible app acts as no one', async () => {
	const t = await setup()

	const callerContext: McpCallerContext = await createPackageAppCallerContext({
		baseUrl,
		owner: t.owner,
		visitor: null,
		packageId: 'pkg-app',
	})
	expect(callerContext.user).toBeNull()
	expect(callerContext.request).toBeNull()

	await expect(t.bridgeFor(null).callCapability(promoteBea)).rejects.toThrow(
		'"orgMemberUpdate" needs a live person',
	)
	expect(await t.beasRole()).toBe('member')
})
