import { env, runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
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

test('RepoSessionIndex drops unused due catalog rows in one cleanup pass', async () => {
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS repo_session_due_owners (
			user_id TEXT PRIMARY KEY NOT NULL,
			due_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	).run()
	const userId = `index-drain-${crypto.randomUUID()}`
	const stub = env.REPO_SESSION_INDEX.get(
		env.REPO_SESSION_INDEX.idFromName(
			repoSessionIndexDurableObjectName(userId),
		),
	)
	const now = '2026-08-16T06:00:00.000Z'
	await runInDurableObject(stub, async (instance: RepoSessionIndex) => {
		await instance.insertSession({
			ownerId: userId,
			row: sessionRow({
				id: 'unused-due-1',
				user_id: userId,
				updated_at: '2026-08-16T05:00:00.000Z',
			}),
		})
		await instance.insertSession({
			ownerId: userId,
			row: sessionRow({
				id: 'unused-due-2',
				user_id: userId,
				source_id: 'source-2',
				updated_at: '2026-08-16T04:00:00.000Z',
			}),
		})
		await instance.insertSession({
			ownerId: userId,
			row: sessionRow({
				id: 'unused-recent',
				user_id: userId,
				source_id: 'source-3',
				updated_at: '2026-08-16T05:50:00.000Z',
			}),
		})
		await instance.insertSession({
			ownerId: userId,
			row: sessionRow({
				id: 'edited-keep',
				user_id: userId,
				source_id: 'source-4',
				last_checkpoint_at: '2026-08-15T12:00:00.000Z',
				last_checkpoint_commit: 'edited',
				updated_at: '2026-08-15T12:00:00.000Z',
			}),
		})
		expect(await instance.countActive({ ownerId: userId })).toBe(4)
		const result = await instance.runDueCleanup({
			ownerId: userId,
			now,
			limit: 10,
		})
		expect(result.checked).toBeGreaterThanOrEqual(2)
		expect(result.errors).toBe(0)
		const remaining = (await instance.listByUser({ ownerId: userId })).map(
			(row) => row.id,
		)
		expect(remaining.sort()).toEqual(['edited-keep', 'unused-recent'])
		expect(await instance.countActive({ ownerId: userId })).toBe(2)
	})
	const due = await env.APP_DB.prepare(
		`SELECT due_at FROM repo_session_due_owners WHERE user_id = ?`,
	)
		.bind(userId)
		.first<{ due_at: string }>()
	expect(due?.due_at).toBe('2026-08-16T06:20:00.000Z')
})
