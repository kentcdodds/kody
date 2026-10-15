import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { mergeFollowPushWindow } from './coalesce.ts'
import {
	ensureFollowTables,
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
	const replaced = mergeFollowPushWindow({
		...base,
		existing: first.pending,
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
		await upsertFollowPushPending(
			db,
			replaced.pending,
			first.pending.updatedAt,
		),
	).toBe(true)
	const stored = await getFollowPushPending(db, base)
	expect(stored?.windowStartedAt).toBe('2026-10-15T00:06:00.000Z')
	expect(stored?.afterCommit).toBe('after-2')
	expect(stored?.commits.map((entry) => entry.id)).toEqual(['c2'])
})

test('upsertFollowPushPending leaves a row whose updated_at moved', async () => {
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
	}
	expect(await upsertFollowPushPending(db, stored, null)).toBe(true)
	const raced = {
		...stored,
		afterCommit: 'after-raced',
		commits: [commit('c1'), commit('c-race')],
		totalCommitsCount: 2,
		updatedAt: '2026-10-15T00:01:00.000Z',
	}
	expect(
		await upsertFollowPushPending(db, raced, '2026-10-14T00:00:00.000Z'),
	).toBe(false)
	expect((await getFollowPushPending(db, base))?.afterCommit).toBe('after-1')
	expect(await upsertFollowPushPending(db, raced, stored.updatedAt)).toBe(true)
	const next = await getFollowPushPending(db, base)
	expect(next?.afterCommit).toBe('after-raced')
	expect(next?.commits.map((entry) => entry.id)).toEqual(['c1', 'c-race'])
})
