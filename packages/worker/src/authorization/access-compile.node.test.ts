import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	bumpAccessEpochStatement,
	compileAccessForRequest,
} from './access-compile.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

async function seedOwner(db: D1Database, email: string) {
	const userId = testStableUserIdFromEmail(email)
	const username = `u${userId.slice(0, 8)}`
	await provisionPersonalOrg(db, {
		stableUserId: userId,
		username,
	})
	return { userId, username }
}

test('owner compile returns every permission without reading grants', async () => {
	const db = await createDb()
	const { userId, username } = await seedOwner(db, 'owner@example.com')
	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(userId),
			username,
		},
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored(userId), slug: username },
			role: 'owner',
		},
	})
	const compiled = await compileAccessForRequest({ db, request })
	expect(compiled.isOwner).toBe(true)
	expect(compiled.orgPermissions.has('package:write')).toBe(true)
	expect(compiled.resourcePermissions.size).toBe(0)
})

test('a Use grant on a package plus the ad-hoc rule grants org:execute', async () => {
	const db = await createDb()
	const { userId, username } = await seedOwner(db, 'owner2@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(userId, memberId, now)
		.run()
	const grantId = crypto.randomUUID()
	const packageId = crypto.randomUUID()
	await db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at
			) VALUES (?, ?, 'package', ?, 'user', ?, 'use', ?, ?, ?)`,
		)
		.bind(grantId, userId, packageId, memberId, userId, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?), (?, ?)`,
		)
		.bind(grantId, 'package:read', grantId, 'package:execute')
		.run()

	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(memberId),
			username: 'member',
		},
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored(userId), slug: username },
			role: 'member',
		},
	})
	const compiled = await compileAccessForRequest({ db, request })
	expect(compiled.isOwner).toBe(false)
	expect(compiled.orgPermissions.has('org:execute')).toBe(true)
	expect(
		compiled.resourcePermissions
			.get(`package:${packageId}`)
			?.has('package:execute'),
	).toBe(true)
	expect(compiled.orgPermissions.has('package:write')).toBe(false)
})

test('bumping access_epoch invalidates the cache on the next compile', async () => {
	const db = await createDb()
	const { userId, username } = await seedOwner(db, 'owner3@example.com')
	const memberId = testStableUserIdFromEmail('member2@example.com')
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(userId, memberId, now)
		.run()
	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(memberId),
			username: 'member',
		},
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored(userId), slug: username },
			role: 'member',
		},
	})
	const first = await compileAccessForRequest({ db, request })
	expect(first.epoch).toBe(0)
	await bumpAccessEpochStatement(db, userId).run()
	const second = await compileAccessForRequest({ db, request })
	expect(second.epoch).toBe(1)
})
