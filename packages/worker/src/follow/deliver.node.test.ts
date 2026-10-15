import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { deliverFollowRecords } from './deliver.ts'
import { ensureFollowTables, getFollowByTarget, insertFollow } from './repo.ts'
import {
	followZeroCreditsSkipReason,
	type FollowPushPending,
	type FollowRecord,
} from './types.ts'

const followerOrgId = 'org-follower'
const now = new Date('2026-10-15T12:00:00.000Z')

function follow(overrides: Partial<FollowRecord> = {}): FollowRecord {
	return {
		id: 'follow-1',
		followerOrgId,
		creatorUserId: 'user-1',
		targetKind: 'package',
		targetOwnerId: 'org-owner',
		targetId: 'pkg-1',
		targetName: '@ada/notes',
		status: 'active',
		pausedAt: null,
		lastDeliverySkipReason: null,
		lastDeliverySkipAt: null,
		createdAt: '2026-10-15T00:00:00.000Z',
		updatedAt: '2026-10-15T00:00:00.000Z',
		...overrides,
	}
}

const target = {
	kind: 'package' as const,
	ownerId: 'org-owner',
	id: 'pkg-1',
	name: '@ada/notes',
	isPrivate: true,
}

const pending: FollowPushPending = {
	targetKind: 'package',
	targetId: 'pkg-1',
	windowStartedAt: '2026-10-15T11:50:00.000Z',
	beforeCommit: 'before',
	afterCommit: 'after',
	ref: 'refs/heads/main',
	commits: [],
	totalCommitsCount: 1,
	updatedAt: '2026-10-15T11:54:00.000Z',
}

async function seed() {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureFollowTables(db)
	await insertFollow(db, {
		id: 'follow-1',
		followerOrgId,
		creatorUserId: 'user-1',
		targetKind: 'package',
		targetOwnerId: 'org-owner',
		targetId: 'pkg-1',
		targetName: '@ada/notes',
		createdAt: '2026-10-15T00:00:00.000Z',
	})
	return db
}

test('delivery pauses a follow when create-level access is gone', async () => {
	const db = await seed()
	const invoke = vi.fn()
	await deliverFollowRecords({
		env: { APP_DB: db } as Env,
		follows: [follow()],
		now,
		published: {
			previousCommit: 'old',
			publishedCommit: 'new',
			publishedAt: now.toISOString(),
		},
		hooks: {
			loadTarget: async () => target,
			resolveAccess: async () => ({ canCreate: false, canPush: false }),
			invoke,
		},
	})
	expect(invoke).not.toHaveBeenCalled()
	const row = await getFollowByTarget(db, {
		followerOrgId,
		targetKind: 'package',
		targetId: 'pkg-1',
	})
	expect(row?.status).toBe('paused')
	expect(row?.pausedAt).toBe(now.toISOString())
})

test('push delivery without package:read skips and does not pause', async () => {
	const db = await seed()
	const invoke = vi.fn()
	await deliverFollowRecords({
		env: { APP_DB: db } as Env,
		follows: [follow()],
		now,
		pushed: pending,
		hooks: {
			loadTarget: async () => target,
			resolveAccess: async () => ({ canCreate: true, canPush: false }),
			invoke,
		},
	})
	expect(invoke).not.toHaveBeenCalled()
	const row = await getFollowByTarget(db, {
		followerOrgId,
		targetKind: 'package',
		targetId: 'pkg-1',
	})
	expect(row?.status).toBe('active')
	expect(row?.pausedAt).toBeNull()
})

test('a 429 invocation is stored on the follow and does not throw', async () => {
	const db = await seed()
	const invoke = vi.fn(async () => ({
		status: 429,
		body: { error: { code: 'entitlement_limit_exceeded' } },
	}))
	await expect(
		deliverFollowRecords({
			env: { APP_DB: db } as Env,
			follows: [follow()],
			now,
			published: {
				previousCommit: 'old',
				publishedCommit: 'new',
				publishedAt: now.toISOString(),
			},
			hooks: {
				loadTarget: async () => ({ ...target, isPrivate: false }),
				resolveAccess: async () => ({ canCreate: true, canPush: true }),
				loadSubscriptions: async () => [
					{
						savedPackage: { id: 'subscriber-1' } as SavedPackageRecord,
						subscription: {
							topic: 'follow.published',
							handler: './src/on-follow.ts',
							description: null,
							filters: null,
						},
					},
				],
				invoke,
			},
		}),
	).resolves.toBeUndefined()
	expect(invoke).toHaveBeenCalledTimes(1)
	const row = await getFollowByTarget(db, {
		followerOrgId,
		targetKind: 'package',
		targetId: 'pkg-1',
	})
	expect(row?.status).toBe('active')
	expect(row?.lastDeliverySkipReason).toBe(followZeroCreditsSkipReason)
	expect(row?.lastDeliverySkipAt).toBe(now.toISOString())
})
