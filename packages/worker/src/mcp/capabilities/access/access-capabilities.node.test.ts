import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { compileAccessForRequest } from '#worker/authorization/access-compile.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { accessGrantCapability } from './access-grants.ts'
import { inviteAcceptCapability, inviteCreateCapability } from './invites.ts'
import { orgCreateCapability } from './org-members.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

function capabilityContext(input: {
	db: D1Database
	userId: string
	email: string
	username: string
	org?: { id: string; slug: string; role: OrgRole }
}) {
	return {
		env: { APP_DB: input.db } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(input.userId),
				email: input.email,
				displayName: input.username,
				username: input.username,
			},
			orgBinding: input.org
				? {
						org: {
							id: ownerIdFromStored(input.org.id),
							slug: input.org.slug,
						},
						role: input.org.role,
					}
				: undefined,
		}),
	}
}

test('orgCreate and accessGrant show up in access compile', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'owneruser',
	})
	const owner = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner@example.com',
		username: 'owneruser',
	})
	const created = await orgCreateCapability.handler(
		{ slug: 'Acme', display_name: 'Acme Co' },
		owner,
	)
	expect(created.org.slug).toBe('acme')
	expect(created.org.display_name).toBe('Acme Co')
	expect(created.org.id).toMatch(/^[a-f0-9]{64}$/)
	expect(created.org.id).not.toBe(ownerId)

	const guestId = testStableUserIdFromEmail('guest@example.com')
	const packageId = crypto.randomUUID()
	const granted = await accessGrantCapability.handler(
		{
			resource_type: 'package',
			resource_id: packageId,
			subject_type: 'user',
			subject_id: guestId,
			preset: 'use',
		},
		capabilityContext({
			db,
			userId: ownerId,
			email: 'owner@example.com',
			username: 'owneruser',
			org: { id: created.org.id, slug: created.org.slug, role: 'owner' },
		}),
	)
	expect(granted.grant.permissions).toEqual(['package:execute', 'package:read'])

	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(guestId),
			username: 'guestuser',
		},
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored(created.org.id), slug: 'acme' },
			role: 'member',
		},
	})
	const compiled = await compileAccessForRequest({ db, request })
	expect(
		compiled.resourcePermissions
			.get(`package:${packageId}`)
			?.has('package:execute'),
	).toBe(true)
	expect(compiled.orgPermissions.has('package:write')).toBe(false)
})

test('inviteCreate prompt names the org and inviteAccept writes membership', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('owner2@example.com')
	const guestId = testStableUserIdFromEmail('guest2@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'owneracct',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guestId,
		username: 'guestacct',
	})
	const ownerOnPersonal = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner2@example.com',
		username: 'owneracct',
	})
	const created = await orgCreateCapability.handler(
		{ slug: 'northwind' },
		ownerOnPersonal,
	)
	const ownerOnOrg = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner2@example.com',
		username: 'owneracct',
		org: { id: created.org.id, slug: created.org.slug, role: 'owner' },
	})
	const invited = await inviteCreateCapability.handler(
		{ kind: 'membership', email: 'Guest2@Example.com', role: 'member' },
		ownerOnOrg,
	)
	expect(invited.invite.org_slug).toBe('northwind')
	expect(invited.invite.status).toBe('pending')
	expect(invited.prompt).toContain('northwind')
	expect(invited.prompt).toContain('inviteAccept')
	expect(invited.prompt).toContain(invited.token)
	expect(invited.prompt).not.toMatch(/[—–]/)
	expect(invited.token).toMatch(/^[a-f0-9]{64}$/)

	const wrongAccount = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner2@example.com',
		username: 'owneracct',
	})
	await expect(
		inviteAcceptCapability.handler({ token: invited.token }, wrongAccount),
	).rejects.toBeInstanceOf(McpCallerError)

	const guest = capabilityContext({
		db,
		userId: guestId,
		email: 'guest2@example.com',
		username: 'guestacct',
	})
	const accepted = await inviteAcceptCapability.handler(
		{ token: invited.token },
		guest,
	)
	expect(accepted).toEqual({
		invite_id: invited.invite.id,
		org_id: created.org.id,
		org_slug: 'northwind',
		kind: 'membership',
		status: 'accepted',
	})
	const membership = await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(created.org.id, guestId)
		.first<{ role: string }>()
	expect(membership?.role).toBe('member')

	const stored = await db
		.prepare(`SELECT token_hash, status FROM invites WHERE id = ?`)
		.bind(invited.invite.id)
		.first<{ token_hash: string; status: string }>()
	expect(stored?.status).toBe('accepted')
	expect(stored?.token_hash).not.toBe(invited.token)
})
