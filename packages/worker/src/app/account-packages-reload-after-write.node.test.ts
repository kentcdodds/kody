import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { handleAccountPackagePublishLockAction } from '#app/account-package-publish-lock.ts'
import { reloadAccountPackagesAfterWrite } from '#app/account-packages-data.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const ownerId = 'person-owner'
const memberId = 'person-member'
const teamId = 'org-acme'
const now = '2026-01-01T00:00:00.000Z'

async function createTeamEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	const insertMembership = sqlite.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, ?, ?)`,
	)
	insertOrg.run(teamId, 'acme', 'Acme', now, now)
	sqlite
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES (?, ?, ?)`,
		)
		.run('acme', teamId, now)
	for (const [id, slug] of [
		[ownerId, 'owner'],
		[memberId, 'member'],
	] as const) {
		insertOrg.run(id, slug, slug, now, now)
		insertMembership.run(id, id, 'owner', now)
	}
	insertMembership.run(teamId, ownerId, 'owner', now)
	insertMembership.run(teamId, memberId, 'member', now)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id, is_private)
			 VALUES (?, ?, ?, ?, 'pkg', ?, 1)`,
		)
		.run('pkg-team', teamId, '@acme/shared', 'shared', 'src-1')
	const insertGrant = sqlite.prepare(
		`INSERT INTO grants (
			id, org_id, resource_type, resource_id, subject_type, subject_id,
			preset, created_by_user_id, created_at, updated_at, deleted_at
		) VALUES (?, ?, 'package', ?, 'user', ?, 'use', ?, ?, ?, NULL)`,
	)
	const insertGrantPermission = sqlite.prepare(
		`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
	)
	insertGrant.run(
		'grant-write',
		teamId,
		'pkg-team',
		memberId,
		ownerId,
		now,
		now,
	)
	insertGrantPermission.run('grant-write', 'package:write')
	return {
		APP_DB: createD1FromSqlite(sqlite),
	} as unknown as Env
}

function memberUser(): AuthenticatedAppUser {
	const actor = personIdFromStored(memberId)
	return {
		sessionUserId: memberId,
		userId: 2,
		username: 'member',
		email: 'member@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'Member',
		roles: [],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: actor,
			email: 'member@example.com',
			username: 'member',
			displayName: 'Member',
		},
		request: sessionRequestContext(actor),
	}
}

test('reload after team package lock includes selectedPackage from the owning org', async () => {
	const env = await createTeamEnv()
	const user = memberUser()
	const request = new Request(
		'https://kody.test/account/packages/pkg-team/settings',
		{ method: 'POST' },
	)
	const response = await handleAccountPackagePublishLockAction({
		env,
		request,
		user,
		body: { action: 'lock', packageId: 'pkg-team' },
	})
	expect(response?.status).toBe(200)
	const payload = (await response?.json()) as {
		selectedPackage?: {
			id: string
			kodyId: string
			name: string
			lockedAt: string
		}
	}
	expect(payload.selectedPackage).toMatchObject({
		id: 'pkg-team',
		kodyId: 'shared',
		name: '@acme/shared',
		lockedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
	})
})

test('reloadAccountPackagesAfterWrite resolves team owner slug for selected package', async () => {
	const env = await createTeamEnv()
	const user = memberUser()
	const data = await reloadAccountPackagesAfterWrite({
		env,
		request: new Request('https://kody.test/account/packages.json'),
		user,
		packageId: 'pkg-team',
		ownerUserId: ownerIdFromStored(teamId),
	})
	expect(data.selectedPackage).toMatchObject({
		id: 'pkg-team',
		kodyId: 'shared',
	})
})
