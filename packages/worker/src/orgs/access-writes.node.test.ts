import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { compileAccessForRequest } from '#worker/authorization/access-compile.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import {
	addOrgMember,
	createOrg,
	softDeleteOrgMember,
	updateOrgMemberRole,
	upsertGrant,
} from './access-writes.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

test('createOrg and upsertGrant are visible when access is compiled', async () => {
	const db = await createDb()
	const creatorId = testStableUserIdFromEmail('creator@example.com')
	const org = await createOrg({
		db,
		slug: 'Acme',
		displayName: 'Acme',
		createdByUserId: creatorId,
	})
	expect(org.slug).toBe('acme')
	expect(org.id).toMatch(/^[a-f0-9]{64}$/)
	expect(org.id).not.toBe(creatorId)

	const memberId = testStableUserIdFromEmail('member@example.com')
	const packageId = crypto.randomUUID()
	const grant = await upsertGrant({
		db,
		orgId: org.id,
		resourceType: 'package',
		resourceId: packageId,
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: creatorId,
	})
	expect(grant.permissions).toEqual(['package:read', 'package:execute'])

	const orgId: string = org.id
	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(memberId),
			username: 'member',
		},
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored(orgId), slug: org.slug },
			role: 'member',
		},
	})
	const compiled = await compileAccessForRequest({ db, request })
	const packagePermissions = compiled.resourcePermissions.get(
		`package:${packageId}`,
	)
	expect(packagePermissions?.has('package:read')).toBe(true)
	expect(packagePermissions?.has('package:execute')).toBe(true)
	expect(compiled.orgPermissions.has('package:write')).toBe(false)
	expect(compiled.orgPermissions.has('org:execute')).toBe(true)
})

test('protectLastOwner blocks demotion and removal when only one owner remains', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('solo-owner@example.com')
	const org = await createOrg({
		db,
		slug: 'solo',
		createdByUserId: ownerId,
	})
	await expect(
		updateOrgMemberRole({
			db,
			orgId: org.id,
			userId: ownerId,
			role: 'member',
			protectLastOwner: true,
		}),
	).rejects.toThrow(/last Owner cannot be demoted/)
	await expect(
		softDeleteOrgMember({
			db,
			orgId: org.id,
			userId: ownerId,
			protectLastOwner: true,
		}),
	).rejects.toThrow(/last Owner cannot be removed/)
	const stillOwner = await db
		.prepare(
			`SELECT role, deleted_at FROM org_memberships
			 WHERE org_id = ? AND user_id = ?`,
		)
		.bind(org.id, ownerId)
		.first<{ role: string; deleted_at: string | null }>()
	expect(stillOwner).toEqual({ role: 'owner', deleted_at: null })
})

test('removing a member soft-deletes their direct user grants', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('grant-owner@example.com')
	const memberId = testStableUserIdFromEmail('grant-member@example.com')
	const org = await createOrg({
		db,
		slug: 'grants',
		createdByUserId: ownerId,
	})
	await addOrgMember({
		db,
		orgId: org.id,
		userId: memberId,
		role: 'member',
		invitedByUserId: ownerId,
	})
	const packageId = crypto.randomUUID()
	const grant = await upsertGrant({
		db,
		orgId: org.id,
		resourceType: 'package',
		resourceId: packageId,
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
	})
	await softDeleteOrgMember({
		db,
		orgId: org.id,
		userId: memberId,
	})
	const membership = await db
		.prepare(
			`SELECT deleted_at FROM org_memberships
			 WHERE org_id = ? AND user_id = ?`,
		)
		.bind(org.id, memberId)
		.first<{ deleted_at: string | null }>()
	expect(membership?.deleted_at).toBeTruthy()
	const storedGrant = await db
		.prepare(`SELECT deleted_at FROM grants WHERE id = ? AND org_id = ?`)
		.bind(grant.id, org.id)
		.first<{ deleted_at: string | null }>()
	expect(storedGrant?.deleted_at).toBeTruthy()
})
