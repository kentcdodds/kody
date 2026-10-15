import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { resourceGrantKey } from '#worker/authorization/access-compile.ts'
import { type EffectivePermissions } from '#worker/authorization/authorize.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	addFollow,
	consumeFollowCreateSlot,
	FollowRateLimitError,
} from './service.ts'
import { followCreateMaxPerHour } from './types.ts'
import {
	ensureFollowTables,
	getFollowByTarget,
	insertFollow,
	pauseFollow,
} from './repo.ts'

const serviceMocks = vi.hoisted(() => ({
	getOrgBySlug: vi.fn(),
	getSavedPackageByName: vi.fn(),
	getUserRepoByName: vi.fn(),
	loadFollowTargetPermissions: vi.fn(),
}))

vi.mock('#worker/orgs/repo.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, getOrgBySlug: serviceMocks.getOrgBySlug }
})

vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		getSavedPackageByName: serviceMocks.getSavedPackageByName,
	}
})

vi.mock('#worker/repo/user-repos.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, getUserRepoByName: serviceMocks.getUserRepoByName }
})

vi.mock('./access.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		loadFollowTargetPermissions: serviceMocks.loadFollowTargetPermissions,
	}
})

test('the 31st new follow in an hour is rejected', async () => {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	for (let index = 0; index < followCreateMaxPerHour; index += 1) {
		await consumeFollowCreateSlot(db, 'org-1')
	}
	await expect(consumeFollowCreateSlot(db, 'org-1')).rejects.toBeInstanceOf(
		FollowRateLimitError,
	)
	await expect(consumeFollowCreateSlot(db, 'org-2')).resolves.toBeUndefined()
})

const ownerId = ownerIdFromStored('org-ada')

function followDb() {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	return db
}

function savedPackage(input: { id: string; name: string; isPrivate: boolean }) {
	return {
		userId: ownerId,
		id: input.id,
		name: input.name,
		isPrivate: input.isPrivate,
	}
}

function executeOnlyAccess(packageId: string): EffectivePermissions {
	return {
		orgId: ownerId,
		permissions: new Set<OrgPermission>(),
		isOwner: false,
		resourcePermissions: new Map([
			[
				resourceGrantKey('package', packageId),
				new Set<OrgPermission>(['package:execute']),
			],
		]),
		credentialScopes: null,
		profileGrants: null,
	}
}

test('execute-only access to a private package is not found', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	serviceMocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	serviceMocks.getSavedPackageByName.mockResolvedValue(
		savedPackage({ id: 'pkg-private', name: '@ada/notes', isPrivate: true }),
	)
	serviceMocks.loadFollowTargetPermissions.mockResolvedValue(
		executeOnlyAccess('pkg-private'),
	)
	await expect(
		addFollow({
			env: { APP_DB: db } as Env,
			followerOrgId: 'org-follower',
			creatorUserId: 'person-1',
			name: '@ada/notes',
		}),
	).rejects.toThrow(/not found/)
	expect(
		await getFollowByTarget(db, {
			followerOrgId: 'org-follower',
			targetKind: 'package',
			targetId: 'pkg-private',
		}),
	).toBeNull()
})

test('the 31st new followAdd in an hour is rejected', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	serviceMocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	serviceMocks.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { name: string }) =>
			savedPackage({ id: input.name, name: input.name, isPrivate: false }),
	)
	serviceMocks.loadFollowTargetPermissions.mockResolvedValue(null)
	for (let index = 0; index < followCreateMaxPerHour; index += 1) {
		await addFollow({
			env: { APP_DB: db } as Env,
			followerOrgId: 'org-limited',
			creatorUserId: 'person-1',
			name: `@ada/pkg-${index}`,
		})
	}
	await expect(
		addFollow({
			env: { APP_DB: db } as Env,
			followerOrgId: 'org-limited',
			creatorUserId: 'person-1',
			name: '@ada/pkg-over',
		}),
	).rejects.toBeInstanceOf(FollowRateLimitError)
})

test('followAdd resumes a paused follow without consuming a create slot', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	await insertFollow(db, {
		id: 'follow-paused',
		followerOrgId: 'org-resume',
		creatorUserId: 'person-1',
		targetKind: 'package',
		targetOwnerId: ownerId,
		targetId: 'pkg-notes',
		targetName: '@ada/notes',
		createdAt: '2026-10-15T00:00:00.000Z',
	})
	await pauseFollow(db, {
		id: 'follow-paused',
		pausedAt: '2026-10-15T01:00:00.000Z',
	})
	for (let index = 0; index < followCreateMaxPerHour; index += 1) {
		await consumeFollowCreateSlot(db, 'org-resume')
	}
	serviceMocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	serviceMocks.getSavedPackageByName.mockResolvedValue(
		savedPackage({ id: 'pkg-notes', name: '@ada/notes', isPrivate: false }),
	)
	serviceMocks.loadFollowTargetPermissions.mockResolvedValue(null)
	const resumed = await addFollow({
		env: { APP_DB: db } as Env,
		followerOrgId: 'org-resume',
		creatorUserId: 'person-2',
		name: '@ada/notes',
	})
	expect(resumed.status).toBe('active')
	expect(resumed.paused_at).toBeNull()
	const row = await getFollowByTarget(db, {
		followerOrgId: 'org-resume',
		targetKind: 'package',
		targetId: 'pkg-notes',
	})
	expect(row?.status).toBe('active')
	expect(row?.pausedAt).toBeNull()
	expect(row?.creatorUserId).toBe('person-2')
})
