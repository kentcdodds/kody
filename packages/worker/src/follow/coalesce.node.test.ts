import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { mergeFollowPushWindow } from './coalesce.ts'
import {
	ensureFollowTables,
	deleteFollowPushPendingIfUnchanged,
	getFollowPushPending,
	upsertFollowPushPending,
} from './repo.ts'
import { followPushMaxCommits, type FollowPushCommit } from './types.ts'

function commit(id: string): FollowPushCommit {
	return {
		id,
		message: id,
		message_truncated: false,
		timestamp: '2026-10-15T00:00:00.000Z',
		author: { name: 'Dev', email: 'dev@example.com' },
		committer: { name: 'Dev', email: 'dev@example.com' },
		parents: [],
	}
}

const base = {
	targetKind: 'package' as const,
	targetId: 'pkg-1',
}

test('pushes inside five minutes collapse into one pending window', () => {
	const first = mergeFollowPushWindow({
		...base,
		existing: null,
		now: new Date('2026-10-15T00:00:00.000Z'),
		incoming: {
			before: 'before-1',
			after: 'after-1',
			ref: 'refs/heads/main',
			commits: [commit('c1')],
			totalCommitsCount: 1,
			at: '2026-10-15T00:00:00.000Z',
		},
	})
	expect(first.action).toBe('merge')
	const second = mergeFollowPushWindow({
		...base,
		existing: first.pending,
		now: new Date('2026-10-15T00:04:00.000Z'),
		incoming: {
			before: 'after-1',
			after: 'after-2',
			ref: 'refs/heads/main',
			commits: [commit('c2'), commit('c3')],
			totalCommitsCount: 2,
			at: '2026-10-15T00:04:00.000Z',
		},
	})
	expect(second.action).toBe('merge')
	expect(second.pending.beforeCommit).toBe('before-1')
	expect(second.pending.afterCommit).toBe('after-2')
	expect(second.pending.windowStartedAt).toBe('2026-10-15T00:00:00.000Z')
	expect(second.pending.commits.map((entry) => entry.id)).toEqual([
		'c1',
		'c2',
		'c3',
	])
	expect(second.pending.totalCommitsCount).toBe(3)
})

test('twenty or more commits in a window are truncated to the newest 20', () => {
	const commits = Array.from({ length: 25 }, (_, index) =>
		commit(`c${index + 1}`),
	)
	const merged = mergeFollowPushWindow({
		...base,
		existing: null,
		now: new Date('2026-10-15T00:00:00.000Z'),
		incoming: {
			before: 'before',
			after: 'after',
			ref: 'refs/heads/main',
			commits,
			totalCommitsCount: 25,
			at: '2026-10-15T00:00:00.000Z',
		},
	})
	expect(merged.pending.commits).toHaveLength(followPushMaxCommits)
	expect(merged.pending.commits[0]?.id).toBe('c6')
	expect(merged.pending.commits.at(-1)?.id).toBe('c25')
	expect(merged.pending.totalCommitsCount).toBe(25)
})

test('a stale webhook appends commits without moving after backward', () => {
	const first = mergeFollowPushWindow({
		...base,
		existing: null,
		now: new Date('2026-10-15T00:04:00.000Z'),
		incoming: {
			before: 'after-1',
			after: 'after-2',
			ref: 'refs/heads/main',
			commits: [commit('c2')],
			totalCommitsCount: 1,
			at: '2026-10-15T00:04:00.000Z',
		},
	})
	const stale = mergeFollowPushWindow({
		...base,
		existing: first.pending,
		now: new Date('2026-10-15T00:04:00.000Z'),
		incoming: {
			before: 'before-1',
			after: 'after-1',
			ref: 'refs/heads/main',
			commits: [commit('c1')],
			totalCommitsCount: 1,
			at: '2026-10-15T00:00:00.000Z',
		},
	})
	expect(stale.action).toBe('merge')
	expect(stale.pending.beforeCommit).toBe('after-1')
	expect(stale.pending.afterCommit).toBe('after-2')
	expect(stale.pending.updatedAt).toBe('2026-10-15T00:04:00.000Z')
	expect(stale.pending.commits.map((entry) => entry.id)).toEqual(['c2', 'c1'])
	expect(stale.pending.totalCommitsCount).toBe(2)
})

test('a delayed old webhook does not reopen a wall-clock-expired window', () => {
	const first = mergeFollowPushWindow({
		...base,
		existing: null,
		now: new Date('2026-10-15T00:00:00.000Z'),
		incoming: {
			before: 'before-1',
			after: 'after-1',
			ref: 'refs/heads/main',
			commits: [commit('c1')],
			totalCommitsCount: 1,
			at: '2026-10-15T00:10:00.000Z',
		},
	})
	expect(first.pending.windowStartedAt).toBe('2026-10-15T00:00:00.000Z')
	const delayed = mergeFollowPushWindow({
		...base,
		existing: first.pending,
		// Wall clock is past the five-minute window even though the delayed
		// event timestamp is still inside the window by event time.
		now: new Date('2026-10-15T00:16:00.000Z'),
		incoming: {
			before: 'before-0',
			after: 'before-1',
			ref: 'refs/heads/main',
			commits: [commit('c0')],
			totalCommitsCount: 1,
			at: '2026-10-15T00:11:00.000Z',
		},
	})
	expect(delayed.action).toBe('replace')
})

test('a delayed burst still coalesces from wall-clock receipt', () => {
	const first = mergeFollowPushWindow({
		...base,
		existing: null,
		now: new Date('2026-10-15T00:10:00.000Z'),
		incoming: {
			before: 'before-1',
			after: 'after-1',
			ref: 'refs/heads/main',
			commits: [commit('c1')],
			totalCommitsCount: 1,
			// Event time is six minutes earlier than receipt.
			at: '2026-10-15T00:04:00.000Z',
		},
	})
	expect(first.action).toBe('merge')
	expect(first.pending.windowStartedAt).toBe('2026-10-15T00:10:00.000Z')
	const second = mergeFollowPushWindow({
		...base,
		existing: first.pending,
		now: new Date('2026-10-15T00:12:00.000Z'),
		incoming: {
			before: 'after-1',
			after: 'after-2',
			ref: 'refs/heads/main',
			commits: [commit('c2')],
			totalCommitsCount: 1,
			at: '2026-10-15T00:05:00.000Z',
		},
	})
	expect(second.action).toBe('merge')
	expect(second.pending.beforeCommit).toBe('before-1')
	expect(second.pending.afterCommit).toBe('after-2')
	expect(second.pending.windowStartedAt).toBe('2026-10-15T00:10:00.000Z')
	expect(second.pending.commits.map((entry) => entry.id)).toEqual(['c1', 'c2'])
})

test('a push after the window replaces the pending row', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureFollowTables(db)
	const first = mergeFollowPushWindow({
		...base,
		existing: null,
		now: new Date('2026-10-15T00:00:00.000Z'),
		incoming: {
			before: 'before-1',
			after: 'after-1',
			ref: 'refs/heads/main',
			commits: [commit('c1')],
			totalCommitsCount: 1,
			at: '2026-10-15T00:00:00.000Z',
		},
	})
	expect(await upsertFollowPushPending(db, first.pending, null)).toBe(true)
	const seeded = await getFollowPushPending(db, base)
	expect(seeded?.revision).toBe(0)
	const replaced = mergeFollowPushWindow({
		...base,
		existing: seeded,
		now: new Date('2026-10-15T00:06:00.000Z'),
		incoming: {
			before: 'after-1',
			after: 'after-2',
			ref: 'refs/heads/main',
			commits: [commit('c2')],
			totalCommitsCount: 1,
			at: '2026-10-15T00:06:00.000Z',
		},
	})
	expect(replaced.action).toBe('replace')
	if (replaced.action !== 'replace') return
	expect(
		await upsertFollowPushPending(db, replaced.pending, seeded),
	).toBe(true)
	const stored = await getFollowPushPending(db, base)
	expect(stored?.windowStartedAt).toBe('2026-10-15T00:06:00.000Z')
	expect(stored?.afterCommit).toBe('after-2')
	expect(stored?.commits.map((entry) => entry.id)).toEqual(['c2'])
	expect(stored?.revision).toBe(1)
})

test('upsertFollowPushPending leaves a row whose revision moved', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureFollowTables(db)
	const stored = {
		...base,
		windowStartedAt: '2026-10-15T00:00:00.000Z',
		beforeCommit: 'before-1',
		afterCommit: 'after-1',
		ref: 'refs/heads/main',
		commits: [commit('c1')],
		totalCommitsCount: 1,
		updatedAt: '2026-10-15T00:00:00.000Z',
		revision: 0,
		generation: '',
	}
	expect(await upsertFollowPushPending(db, stored, null)).toBe(true)
	const raced = {
		...stored,
		afterCommit: 'after-raced',
		commits: [commit('c1'), commit('c-race')],
		totalCommitsCount: 2,
		updatedAt: '2026-10-15T00:01:00.000Z',
	}
	const read = await getFollowPushPending(db, base)
	expect(read?.revision).toBe(0)
	expect(read?.generation).not.toBe('')
	expect(
		await upsertFollowPushPending(db, raced, {
			revision: -1,
			generation: read?.generation ?? '',
		}),
	).toBe(false)
	expect((await getFollowPushPending(db, base))?.afterCommit).toBe('after-1')
	expect(await upsertFollowPushPending(db, raced, read)).toBe(true)
	const next = await getFollowPushPending(db, base)
	expect(next?.afterCommit).toBe('after-raced')
	expect(next?.commits.map((entry) => entry.id)).toEqual(['c1', 'c-race'])
	expect(next?.revision).toBe(1)
})

test('same event timestamp still serializes concurrent merges via revision', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureFollowTables(db)
	const at = '2026-10-15T00:00:00.000Z'
	const first = mergeFollowPushWindow({
		...base,
		existing: null,
		now: new Date(at),
		incoming: {
			before: 'before-1',
			after: 'after-1',
			ref: 'refs/heads/main',
			commits: [commit('c1')],
			totalCommitsCount: 1,
			at,
		},
	})
	expect(await upsertFollowPushPending(db, first.pending, null)).toBe(true)
	const sharedAt = await getFollowPushPending(db, base)
	expect(sharedAt?.revision).toBe(0)
	expect(sharedAt?.updatedAt).toBe(at)

	const writerA = mergeFollowPushWindow({
		...base,
		existing: sharedAt,
		now: new Date('2026-10-15T00:01:00.000Z'),
		incoming: {
			before: 'after-1',
			after: 'after-a',
			ref: 'refs/heads/main',
			commits: [commit('c-a')],
			totalCommitsCount: 1,
			at,
		},
	})
	const writerB = mergeFollowPushWindow({
		...base,
		existing: sharedAt,
		now: new Date('2026-10-15T00:01:00.000Z'),
		incoming: {
			before: 'after-1',
			after: 'after-b',
			ref: 'refs/heads/main',
			commits: [commit('c-b')],
			totalCommitsCount: 1,
			at,
		},
	})
	expect(writerA.action).toBe('merge')
	expect(writerB.action).toBe('merge')
	// Same webhook timestamp: updatedAt would not move, so CAS must use revision.
	expect(writerA.pending.updatedAt).toBe(at)
	expect(writerB.pending.updatedAt).toBe(at)

	expect(
		await upsertFollowPushPending(db, writerA.pending, sharedAt),
	).toBe(true)
	expect(
		await upsertFollowPushPending(db, writerB.pending, sharedAt),
	).toBe(false)

	const afterA = await getFollowPushPending(db, base)
	expect(afterA?.revision).toBe(1)
	expect(afterA?.commits.map((entry) => entry.id)).toEqual(['c1', 'c-a'])

	const retried = mergeFollowPushWindow({
		...base,
		existing: afterA,
		now: new Date('2026-10-15T00:01:00.000Z'),
		incoming: {
			before: 'after-1',
			after: 'after-b',
			ref: 'refs/heads/main',
			commits: [commit('c-b')],
			totalCommitsCount: 1,
			at,
		},
	})
	expect(retried.action).toBe('merge')
	expect(
		await upsertFollowPushPending(db, retried.pending, afterA),
	).toBe(true)
	const both = await getFollowPushPending(db, base)
	expect(both?.revision).toBe(2)
	expect(both?.updatedAt).toBe(at)
	expect(both?.commits.map((entry) => entry.id)).toEqual(['c1', 'c-a', 'c-b'])
	expect(both?.totalCommitsCount).toBe(3)
})

test('a reinserted window does not match a stale snapshot at revision 0', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureFollowTables(db)
	const window = (after: string, id: string) =>
		mergeFollowPushWindow({
			...base,
			existing: null,
			now: new Date('2026-10-15T00:00:00.000Z'),
			incoming: {
				before: 'before',
				after,
				ref: 'refs/heads/main',
				commits: [commit(id)],
				totalCommitsCount: 1,
				at: '2026-10-15T00:00:00.000Z',
			},
		}).pending
	expect(await upsertFollowPushPending(db, window('after-old', 'c-old'), null)).toBe(true)
	const stale = await getFollowPushPending(db, base)
	if (!stale) throw new Error('expected a pending row')

	// Flush A deletes the window; push C inserts a fresh one (revision 0 again).
	expect(await deleteFollowPushPendingIfUnchanged(db, stale)).toBe(true)
	// A stale writer that read the deleted row must not recreate it.
	expect(await upsertFollowPushPending(db, stale, stale)).toBe(false)
	expect(await getFollowPushPending(db, base)).toBeNull()
	expect(await upsertFollowPushPending(db, window('after-new', 'c-new'), null)).toBe(true)
	const fresh = await getFollowPushPending(db, base)
	expect(fresh?.revision).toBe(0)
	expect(fresh?.generation).not.toBe(stale.generation)
	// An insert never clobbers an existing row.
	expect(await upsertFollowPushPending(db, window('after-x', 'c-x'), null)).toBe(false)

	// Flush B still holds the old revision-0 snapshot: it must not delete C.
	expect(await deleteFollowPushPendingIfUnchanged(db, stale)).toBe(false)
	// A delayed writer holding the old snapshot must not overwrite C either.
	expect(
		await upsertFollowPushPending(
			db,
			{ ...stale, afterCommit: 'after-stale' },
			stale,
		),
	).toBe(false)
	const kept = await getFollowPushPending(db, base)
	expect(kept?.afterCommit).toBe('after-new')
	expect(kept?.commits.map((entry) => entry.id)).toEqual(['c-new'])
})
