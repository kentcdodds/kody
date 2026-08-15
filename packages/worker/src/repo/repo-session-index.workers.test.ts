import { env, runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { repoSessionIndexDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { RepoSessionIndex } from './repo-session-index-do.ts'
import { type RepoSessionRow } from './types.ts'

function sessionRow(
	overrides: Partial<RepoSessionRow> & Pick<RepoSessionRow, 'id' | 'user_id'>,
): RepoSessionRow {
	return {
		source_id: 'source-1',
		source_repo_id: 'repo-1',
		session_branch: `sessions/${overrides.id}`,
		source_branch: 'main',
		base_commit: 'commit',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-06-24T19:00:00.000Z',
		updated_at: '2026-06-24T19:00:00.000Z',
		...overrides,
	}
}

test('RepoSessionIndex is the catalog authority for one user', async () => {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS repo_session_due_owners (
			user_id TEXT PRIMARY KEY NOT NULL,
			due_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	).run()
	const userId = `index-${crypto.randomUUID()}`
	const stub = env.REPO_SESSION_INDEX.get(
		env.REPO_SESSION_INDEX.idFromName(
			repoSessionIndexDurableObjectName(userId),
		),
	)
	await runInDurableObject(stub, async (instance: RepoSessionIndex) => {
		expect(instance).toBeInstanceOf(RepoSessionIndex)
		await instance.insertSession({
			ownerId: userId,
			row: sessionRow({
				id: 'session-1',
				user_id: userId,
				conversation_id: 'convo-1',
			}),
		})
		await instance.insertSession({
			ownerId: userId,
			row: sessionRow({
				id: 'session-2',
				user_id: userId,
				source_id: 'source-2',
				status: 'published',
				expires_at: '2026-06-24T12:00:00.000Z',
			}),
		})
		expect(await instance.countActive({ ownerId: userId })).toBe(1)
		expect(
			await instance.hasActiveForSource({
				ownerId: userId,
				sourceId: 'source-1',
			}),
		).toBe(true)
		expect(
			(
				await instance.getActiveByConversation({
					ownerId: userId,
					conversationId: 'convo-1',
				})
			)?.id,
		).toBe('session-1')
		expect(
			(await instance.listByUser({ ownerId: userId })).map((row) => row.id),
		).toEqual(['session-2', 'session-1'])
		expect(
			await instance.deleteSession({
				ownerId: userId,
				sessionId: 'session-2',
			}),
		).toBe(true)
		expect(await instance.countActive({ ownerId: userId })).toBe(1)
		const exported = await instance.exportSessions({ ownerId: userId })
		expect(exported.rows.map((row) => row.id)).toEqual(['session-1'])
		expect(exported.total).toBe(1)
		expect(await instance.countAll({ ownerId: userId })).toBe(1)
		await instance.purge({ ownerId: userId })
		expect(await instance.listByUser({ ownerId: userId })).toEqual([])
	})
})

test('hydrate imports leftover D1 once, then leftover deletes cannot resurrect', async () => {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS repo_session_due_owners (
			user_id TEXT PRIMARY KEY NOT NULL,
			due_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	).run()
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS repo_sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			source_repo_id TEXT NOT NULL,
			session_branch TEXT NOT NULL,
			source_branch TEXT NOT NULL,
			base_commit TEXT NOT NULL,
			source_root TEXT NOT NULL,
			conversation_id TEXT,
			status TEXT NOT NULL,
			expires_at TEXT,
			last_checkpoint_at TEXT,
			last_checkpoint_commit TEXT,
			last_check_run_id TEXT,
			last_check_tree_hash TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	).run()
	const userId = `hydrate-${crypto.randomUUID()}`
	const leftover = sessionRow({
		id: 'leftover-1',
		user_id: userId,
	})
	await env.APP_DB.prepare(
		`INSERT INTO repo_sessions (
			id, user_id, source_id, source_repo_id, session_branch, source_branch,
			base_commit, source_root, conversation_id, status, expires_at,
			last_checkpoint_at, last_checkpoint_commit, last_check_run_id,
			last_check_tree_hash, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			leftover.id,
			leftover.user_id,
			leftover.source_id,
			leftover.source_repo_id,
			leftover.session_branch,
			leftover.source_branch,
			leftover.base_commit,
			leftover.source_root,
			leftover.conversation_id,
			leftover.status,
			leftover.expires_at,
			leftover.last_checkpoint_at,
			leftover.last_checkpoint_commit,
			leftover.last_check_run_id,
			leftover.last_check_tree_hash,
			leftover.created_at,
			leftover.updated_at,
		)
		.run()
	const stub = env.REPO_SESSION_INDEX.get(
		env.REPO_SESSION_INDEX.idFromName(
			repoSessionIndexDurableObjectName(userId),
		),
	)
	await runInDurableObject(stub, async (instance: RepoSessionIndex) => {
		const first = await instance.hydrateFromD1({ ownerId: userId })
		expect(first.imported).toBe(1)
		expect(first.leftoverRemaining).toBe(0)
		expect(await instance.countAll({ ownerId: userId })).toBe(1)
		await instance.deleteSession({
			ownerId: userId,
			sessionId: leftover.id,
		})
		await env.APP_DB.prepare(
			`INSERT INTO repo_sessions (
				id, user_id, source_id, source_repo_id, session_branch, source_branch,
				base_commit, source_root, conversation_id, status, expires_at,
				last_checkpoint_at, last_checkpoint_commit, last_check_run_id,
				last_check_tree_hash, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				leftover.id,
				leftover.user_id,
				leftover.source_id,
				leftover.source_repo_id,
				leftover.session_branch,
				leftover.source_branch,
				leftover.base_commit,
				leftover.source_root,
				leftover.conversation_id,
				leftover.status,
				leftover.expires_at,
				leftover.last_checkpoint_at,
				leftover.last_checkpoint_commit,
				leftover.last_check_run_id,
				leftover.last_check_tree_hash,
				leftover.created_at,
				leftover.updated_at,
			)
			.run()
		const second = await instance.hydrateFromD1({ ownerId: userId })
		expect(second.imported).toBe(0)
		expect(second.leftoverRemaining).toBe(0)
		expect(
			await instance.getSessionById({
				ownerId: userId,
				sessionId: leftover.id,
			}),
		).toBeNull()
	})
})
