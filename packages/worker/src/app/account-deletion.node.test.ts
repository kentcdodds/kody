import { expect, test, vi } from 'vitest'
import { deleteUserAccount } from './account-deletion.ts'

type RowMap = Record<string, Array<Record<string, unknown>>>

function createTestDb(initial: RowMap): {
	db: D1Database
	rows: RowMap
} {
	const rows: RowMap = {}
	for (const [key, value] of Object.entries(initial)) {
		rows[key] = value.map((row) => ({ ...row }))
	}

	function deleteByPredicate(
		table: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) {
		const remaining: Array<Record<string, unknown>> = []
		let removed = 0
		for (const row of rows[table] ?? []) {
			if (predicate(row)) {
				removed += 1
				continue
			}
			remaining.push(row)
		}
		rows[table] = remaining
		return removed
	}

	function selectIds(
		table: string,
		where: (row: Record<string, unknown>) => boolean,
	) {
		return (rows[table] ?? []).filter(where).map((row) => row['id'])
	}

	const db = {
		prepare(query: string) {
			const trimmed = query.replace(/\s+/g, ' ').trim()
			const lower = trimmed.toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							let results: Array<unknown> = []
							const userId = params[0] as string
							const m = lower.match(/^select id from (\w+) where user_id = \?/)
							if (m) {
								const table = m[1] as string
								results = (rows[table] ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({ id: row['id'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							const storageMatch = lower.match(
								/^select storage_id from (\w+) where user_id = \? and storage_id is not null/,
							)
							if (storageMatch) {
								const table = storageMatch[1] as string
								results = (rows[table] ?? [])
									.filter(
										(row) =>
											row['user_id'] === userId && row['storage_id'] != null,
									)
									.map((row) => ({ storage_id: row['storage_id'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							const kvMatch = lower.match(
								/^select kv_key from (\w+) where user_id = \?/,
							)
							if (kvMatch) {
								const table = kvMatch[1] as string
								results = (rows[table] ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({ kv_key: row['kv_key'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async first<T>() {
							const result = await this.all<T>()
							return (result.results[0] ?? null) as T | null
						},
						async run() {
							const userId = params[0] as string | number
							const userIdMatch = lower.match(
								/^delete from (\w+) where user_id = \?/,
							)
							if (userIdMatch) {
								const table = userIdMatch[1] as string
								const removed = deleteByPredicate(
									table,
									(row) => row['user_id'] === userId,
								)
								return { meta: { changes: removed } }
							}
							const bucketParentMatch = lower.match(
								/^delete from (\w+) where bucket_id in \( select id from (\w+) where user_id = \? \)/,
							)
							if (bucketParentMatch) {
								const childTable = bucketParentMatch[1] as string
								const parentTable = bucketParentMatch[2] as string
								const parentIds = new Set(
									selectIds(parentTable, (row) => row['user_id'] === userId),
								)
								const removed = deleteByPredicate(childTable, (row) =>
									parentIds.has(row['bucket_id']),
								)
								return { meta: { changes: removed } }
							}
							const attachmentMatch = lower.match(
								/^delete from email_attachments where message_id in \( select id from email_messages where user_id = \? \)/,
							)
							if (attachmentMatch) {
								const messageIds = new Set(
									selectIds(
										'email_messages',
										(row) => row['user_id'] === userId,
									),
								)
								const removed = deleteByPredicate('email_attachments', (row) =>
									messageIds.has(row['message_id']),
								)
								return { meta: { changes: removed } }
							}
							const usersMatch = lower.match(/^delete from users where id = \?/)
							if (usersMatch) {
								const removed = deleteByPredicate(
									'users',
									(row) => row['id'] === userId,
								)
								return { meta: { changes: removed } }
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return { db, rows }
}

test('deleteUserAccount cascades user-scoped rows for the requested user', async () => {
	const userAaa = 'user-aaa'
	const userBbb = 'user-bbb'
	const { db, rows } = createTestDb({
		users: [
			{ id: 1, email: 'a@example.com' },
			{ id: 2, email: 'b@example.com' },
		],
		jobs: [
			{ id: 'job-1', user_id: userAaa, storage_id: 'job:job-1' },
			{ id: 'job-2', user_id: userAaa, storage_id: null },
			{ id: 'job-3', user_id: userBbb, storage_id: 'job:job-3' },
		],
		mcp_memories: [
			{ id: 'mem-1', user_id: userAaa },
			{ id: 'mem-2', user_id: userBbb },
		],
		secret_buckets: [{ id: 'sb-1', user_id: userAaa }],
		secret_entries: [{ bucket_id: 'sb-1', name: 's', user_id: 'unused' }],
		value_buckets: [{ id: 'vb-1', user_id: userAaa }],
		value_entries: [{ bucket_id: 'vb-1', name: 'v', user_id: 'unused' }],
		remote_connector_settings: [
			{ id: 'rc-1', user_id: userAaa },
			{ id: 'rc-2', user_id: userBbb },
		],
		saved_packages: [
			{ id: 'pkg-1', user_id: userAaa },
			{ id: 'pkg-2', user_id: userBbb },
		],
		published_bundle_artifacts: [
			{ id: 'pba-1', user_id: userAaa, kv_key: 'bundle-artifact:v1:src-1' },
			{ id: 'pba-2', user_id: userBbb, kv_key: 'bundle-artifact:v1:src-2' },
		],
		archived_job_artifacts: [
			{ id: 'aja-1', user_id: userAaa, kv_key: 'archived:src-1' },
		],
		entity_sources: [{ id: 'es-1', user_id: userAaa }],
		repo_sessions: [{ id: 'rs-1', user_id: userAaa }],
		chat_threads: [{ id: 't-1', user_id: userAaa }],
		password_resets: [
			{ id: 1, user_id: 1 },
			{ id: 2, user_id: 1 },
			{ id: 3, user_id: 2 },
		],
		user_roles: [
			{ user_id: 1, role_id: 1 },
			{ user_id: 2, role_id: 2 },
		],
		mcp_user_server_instructions: [{ user_id: userAaa }],
		package_invocation_tokens: [{ id: 'pit-1', user_id: userAaa }],
		package_invocations: [{ id: 'pi-1', user_id: userAaa }],
		workflow_runs: [{ id: 'wr-1', user_id: userAaa }],
		mcp_memory_conversation_suppressions: [
			{ user_id: userAaa, conversation_id: 'c1', memory_id: 'mem-1' },
		],
		email_inboxes: [{ id: 'in-1', user_id: userAaa }],
		email_inbox_addresses: [{ id: 'ia-1', user_id: userAaa }],
		email_threads: [{ id: 'et-1', user_id: userAaa }],
		email_messages: [{ id: 'em-1', user_id: userAaa }],
		email_attachments: [{ id: 'ea-1', message_id: 'em-1' }],
		email_delivery_events: [{ id: 'ed-1', user_id: userAaa }],
		email_sender_identities: [{ id: 'ei-1', user_id: userAaa }],
	})

	const deletedKvKeys: Array<string> = []
	const kv = {
		async delete(key: string) {
			deletedKvKeys.push(key)
		},
	} as unknown as KVNamespace

	const clearStorageMock = vi.fn(async () => ({ ok: true as const }))
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: kv,
		STORAGE_RUNNER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ clearStorage: clearStorageMock }),
		},
	} as unknown as Env

	// password_resets.user_id is the database integer id; the deletion
	// service must use the dbUserId (1) to clear the deleted user's reset
	// tokens while leaving the other user's tokens in place.
	const result = await deleteUserAccount({
		env: env as Env & { OAUTH_PROVIDER: undefined },
		dbUserId: 1,
		mcpUserId: userAaa,
	})

	// Cross-user data is preserved.
	expect(rows.jobs).toEqual([
		{ id: 'job-3', user_id: userBbb, storage_id: 'job:job-3' },
	])
	expect(rows.mcp_memories).toEqual([{ id: 'mem-2', user_id: userBbb }])
	expect(rows.saved_packages).toEqual([{ id: 'pkg-2', user_id: userBbb }])
	expect(rows.remote_connector_settings).toEqual([
		{ id: 'rc-2', user_id: userBbb },
	])
	expect(rows.published_bundle_artifacts).toEqual([
		{ id: 'pba-2', user_id: userBbb, kv_key: 'bundle-artifact:v1:src-2' },
	])
	expect(rows.password_resets).toEqual([{ id: 3, user_id: 2 }])
	expect(rows.user_roles).toEqual([{ user_id: 2, role_id: 2 }])

	// User-scoped data is removed.
	expect(rows.secret_buckets).toEqual([])
	expect(rows.secret_entries).toEqual([])
	expect(rows.value_buckets).toEqual([])
	expect(rows.value_entries).toEqual([])
	expect(rows.archived_job_artifacts).toEqual([])
	expect(rows.entity_sources).toEqual([])
	expect(rows.repo_sessions).toEqual([])
	expect(rows.chat_threads).toEqual([])
	expect(rows.email_attachments).toEqual([])
	expect(rows.email_messages).toEqual([])
	expect(rows.users).toEqual([{ id: 2, email: 'b@example.com' }])
	expect(result.deletedRowCounts.password_resets).toBe(2)
	expect(result.deletedRowCounts.user_roles).toBe(1)

	// Storage runners for the deleted user's storage_ids were cleared.
	expect(clearStorageMock).toHaveBeenCalledTimes(1)

	// Bundle KV keys for the deleted user were removed; the other user's keys
	// remain in storage.
	expect(deletedKvKeys.sort()).toEqual([
		'archived:src-1',
		'bundle-artifact:v1:src-1',
	])

	// Result accounting captures the per-table counts.
	expect(result.deletedRowCounts.jobs).toBe(2)
	expect(result.deletedRowCounts.users).toBe(1)
	expect(result.deletedRowCounts.email_attachments).toBe(1)
	expect(result.warnings.length).toBeGreaterThan(0)
})

test('deleteUserAccount handles OAuth grant revocation and warning-only edge cases', async () => {
	const revokeGrant = vi.fn(async () => undefined)
	const { db: revokeDb } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
	})
	const revokeResult = await deleteUserAccount({
		env: {
			APP_DB: revokeDb,
			OAUTH_PROVIDER: {
				async listUserGrants() {
					return {
						items: [
							{ id: 'grant-1', clientId: 'client-1' },
							{ id: 'grant-2', clientId: 'client-2' },
						],
						cursor: undefined,
					}
				},
				revokeGrant,
			},
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ clearStorage: async () => ({ ok: true as const }) }),
			},
		} as unknown as Parameters<typeof deleteUserAccount>[0]['env'],
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(revokeGrant).toHaveBeenCalledTimes(2)
	expect(revokeResult.revokedOAuthGrants).toBe(2)

	const { db: oauthFailureDb, rows: oauthFailureRows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
		jobs: [{ id: 'job-1', user_id: 'user-aaa', storage_id: null }],
	})
	const oauthFailureResult = await deleteUserAccount({
		env: {
			APP_DB: oauthFailureDb,
			OAUTH_PROVIDER: {
				async listUserGrants() {
					throw new Error('OAuth provider is temporarily unavailable')
				},
				revokeGrant: vi.fn(async () => undefined),
			},
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ clearStorage: async () => ({ ok: true as const }) }),
			},
		} as unknown as Parameters<typeof deleteUserAccount>[0]['env'],
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(oauthFailureRows.jobs).toEqual([])
	expect(oauthFailureRows.users).toEqual([])
	expect(oauthFailureResult.revokedOAuthGrants).toBe(0)
	expect(oauthFailureResult.warnings.length).toBeGreaterThan(0)

	const { db: kvFailureDb, rows: kvFailureRows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
		published_bundle_artifacts: [
			{ id: 'pba-1', user_id: 'user-aaa', kv_key: 'bundle-artifact:v1:src-1' },
		],
		archived_job_artifacts: [
			{ id: 'aja-1', user_id: 'user-aaa', kv_key: 'archived:src-1' },
		],
	})
	const kvFailureResult = await deleteUserAccount({
		env: {
			APP_DB: kvFailureDb,
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ clearStorage: async () => ({ ok: true as const }) }),
			},
		} as unknown as Parameters<typeof deleteUserAccount>[0]['env'],
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(kvFailureRows.published_bundle_artifacts).toEqual([])
	expect(kvFailureRows.archived_job_artifacts).toEqual([])
	expect(kvFailureResult.deletedKvKeys).toBe(0)
	expect(kvFailureResult.warnings.length).toBeGreaterThan(0)
})
