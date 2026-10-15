import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureFollowForCommunityFork } from './fork-follow.ts'
import {
	ensureFollowTables,
	getFollowByTarget,
	insertFollow,
	pauseFollow,
} from './repo.ts'

const listingMocks = vi.hoisted(() => ({
	getCommunityListingById: vi.fn(),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: listingMocks.getCommunityListingById,
}))

const listing = {
	packageId: 'pkg-notes',
	name: '@ada/notes',
	ownerUserId: 'org-ada',
}

test('forking resumes a paused upstream follow for the forking person', async () => {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureFollowTables(db)
	await insertFollow(db, {
		id: 'follow-paused',
		followerOrgId: 'org-forker',
		creatorUserId: 'person-original',
		targetKind: 'package',
		targetOwnerId: 'org-ada',
		targetId: 'pkg-notes',
		targetName: '@ada/notes',
		createdAt: '2026-10-15T00:00:00.000Z',
	})
	await pauseFollow(db, {
		id: 'follow-paused',
		pausedAt: '2026-10-15T01:00:00.000Z',
		reason: 'access_lost',
	})
	listingMocks.getCommunityListingById.mockResolvedValue(listing)
	await ensureFollowForCommunityFork({
		env: { APP_DB: db } as Env,
		listingId: 'listing-1',
		followerOrgId: 'org-forker',
		creatorUserId: 'person-forker',
	})
	const row = await getFollowByTarget(db, {
		followerOrgId: 'org-forker',
		targetKind: 'package',
		targetId: 'pkg-notes',
	})
	expect(row?.status).toBe('active')
	expect(row?.pausedAt).toBeNull()
	expect(row?.creatorUserId).toBe('person-forker')
})

test('forking leaves an active upstream follow and its creator in place', async () => {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureFollowTables(db)
	await insertFollow(db, {
		id: 'follow-active',
		followerOrgId: 'org-forker',
		creatorUserId: 'person-original',
		targetKind: 'package',
		targetOwnerId: 'org-ada',
		targetId: 'pkg-notes',
		targetName: '@ada/notes',
		createdAt: '2026-10-15T00:00:00.000Z',
	})
	listingMocks.getCommunityListingById.mockResolvedValue(listing)
	await ensureFollowForCommunityFork({
		env: { APP_DB: db } as Env,
		listingId: 'listing-1',
		followerOrgId: 'org-forker',
		creatorUserId: 'person-forker',
	})
	const row = await getFollowByTarget(db, {
		followerOrgId: 'org-forker',
		targetKind: 'package',
		targetId: 'pkg-notes',
	})
	expect(row?.status).toBe('active')
	expect(row?.creatorUserId).toBe('person-original')
})
