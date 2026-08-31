import { expect, test, vi } from 'vitest'
import {
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
	deleteUserAccount,
} from './account-deletion.ts'
import {
	AccountDeletionInProgressError,
	AccountDeletionWritersActiveError,
	assertAccountWritable,
} from '#worker/account/deletion-state.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import {
	createTestDb,
	createSuccessfulDeletionEnv,
} from '#worker/test-support/account-deletion.ts'

test('deleteUserAccount revokes OAuth grants and fails closed on critical cleanup errors', async () => {
	const revokeGrant = vi.fn(async () => undefined)
	const { db: revokeDb } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
	})
	const revokeResult = await deleteUserAccount({
		env: createSuccessfulDeletionEnv(revokeDb, {
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
		}),
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(revokeGrant).toHaveBeenCalledTimes(2)
	expect(revokeResult.revokedOAuthGrants).toBe(2)
	expect(revokeResult.warnings).toEqual([])

	const deleteClient = vi.fn(async () => undefined)
	const { db: ownedClientDb } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
		user_mcp_oauth_clients: [
			{
				id: 'row-1',
				user_id: 1,
				client_id: 'owned-client',
				revoked_at: null,
			},
			{
				id: 'row-2',
				user_id: 1,
				client_id: 'already-revoked',
				revoked_at: '2026-08-01T00:00:00.000Z',
			},
		],
	})
	await deleteUserAccount({
		env: createSuccessfulDeletionEnv(ownedClientDb, {
			OAUTH_PROVIDER: {
				async listUserGrants() {
					return { items: [], cursor: undefined }
				},
				revokeGrant: vi.fn(async () => undefined),
				deleteClient,
			},
		}),
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(deleteClient).toHaveBeenCalledTimes(2)
	expect(deleteClient).toHaveBeenCalledWith('owned-client')
	expect(deleteClient).toHaveBeenCalledWith('already-revoked')

	const { db: missingDeleteDb, rows: missingDeleteRows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
		jobs: [{ id: 'job-1', user_id: 'user-aaa', storage_id: null }],
		user_mcp_oauth_clients: [
			{
				id: 'row-1',
				user_id: 1,
				client_id: 'owned-client',
				revoked_at: null,
			},
		],
	})
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(missingDeleteDb, {
				OAUTH_PROVIDER: {
					async listUserGrants() {
						return { items: [], cursor: undefined }
					},
					revokeGrant: vi.fn(async () => undefined),
				},
			}),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toMatchObject({
		name: 'AccountDeletionCleanupError',
		cleanupErrors: [
			'OAuth provider does not support client deletion; MCP OAuth clients were not removed.',
		],
	})
	expect(missingDeleteRows.users).toEqual([expect.objectContaining({ id: 1 })])

	const { db: oauthFailureDb, rows: oauthFailureRows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
		jobs: [{ id: 'job-1', user_id: 'user-aaa', storage_id: null }],
	})
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(oauthFailureDb, {
				OAUTH_PROVIDER: {
					async listUserGrants() {
						throw new Error('OAuth provider is temporarily unavailable')
					},
					revokeGrant: vi.fn(async () => undefined),
				},
			}),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toBeInstanceOf(AccountDeletionCleanupError)
	expect(oauthFailureRows.jobs).toEqual([
		{ id: 'job-1', user_id: 'user-aaa', storage_id: null },
	])
	expect(oauthFailureRows.users).toEqual([
		expect.objectContaining({
			id: 1,
			email: 'a@example.com',
			deleting_at: expect.any(String),
		}),
	])

	const { db: kvFailureDb, rows: kvFailureRows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
		published_bundle_artifacts: [
			{ id: 'pba-1', user_id: 'user-aaa', kv_key: 'bundle-artifact:v1:src-1' },
		],
		archived_job_artifacts: [
			{ id: 'aja-1', user_id: 'user-aaa', kv_key: 'archived:src-1' },
		],
	})
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(kvFailureDb, {
				BUNDLE_ARTIFACTS_KV: {
					delete: vi.fn(async () => undefined),
					list: vi.fn(async () => ({
						keys: [],
						list_complete: true,
						cursor: undefined,
					})),
				},
				EMAIL_BLOBS: {
					list: vi.fn(async () => ({
						objects: [{ key: 'email-raw:v1:user-aaa/em-1' }],
						delimitedPrefixes: [],
						truncated: false,
					})),
					delete: vi.fn(async () => {
						throw new Error('simulated R2 outage')
					}),
				},
			}),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toMatchObject({
		cleanupErrors: expect.arrayContaining([
			expect.stringContaining('Email raw MIME prefix delete failed'),
		]),
	})
	expect(kvFailureRows.published_bundle_artifacts).toHaveLength(1)
	expect(kvFailureRows.archived_job_artifacts).toHaveLength(1)
	expect(kvFailureRows.users).toEqual([
		expect.objectContaining({
			id: 1,
			email: 'a@example.com',
			deleting_at: expect.any(String),
		}),
	])
})

test('account deletion reports missing Durable Object / blob bindings and remains retryable', async () => {
	const missingBindings = [
		{
			envOverrides: { EMAIL_BLOBS: undefined },
			cleanupError:
				'EMAIL_BLOBS binding was unavailable; email objects were not removed.',
			seed: {
				users: [
					{
						id: 1,
						email: 'a@example.com',
						stable_user_id: 'user-aaa',
					},
				],
			},
		},
	] as const

	for (const scenario of missingBindings) {
		const { db, rows } = createTestDb(scenario.seed)
		await expect(
			deleteUserAccount({
				env: createSuccessfulDeletionEnv(db, scenario.envOverrides),
				dbUserId: 1,
				mcpUserId: 'user-aaa',
			}),
		).rejects.toMatchObject({
			cleanupErrors: expect.arrayContaining([scenario.cleanupError]),
			...('partialResult' in scenario
				? { partialResult: scenario.partialResult }
				: {}),
		})
		scenario.assertRows?.(rows)
		expect(rows.users).toEqual([
			expect.objectContaining({
				id: 1,
				deleting_at: expect.any(String),
			}),
		])
	}

	const { db: missingMailboxDb, rows: missingMailboxRows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com', stable_user_id: 'user-aaa' }],
	})
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(missingMailboxDb, {
				MAILBOX: undefined,
			}),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toMatchObject({
		name: 'AccountDeletionInventoryError',
		inventoryErrors: [
			expect.stringContaining(
				'MAILBOX Durable Object binding is not configured',
			),
		],
	})
	expect(missingMailboxRows.users).toEqual([
		expect.objectContaining({
			id: 1,
			deleting_at: null,
		}),
	])

	const { db: missingMeterDb, rows: missingMeterRows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com', stable_user_id: 'user-aaa' }],
	})
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(missingMeterDb, {
				USER_METER: undefined,
			}),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toThrow('USER_METER Durable Object binding is not configured.')
	expect(missingMeterRows.users).toEqual([
		expect.objectContaining({
			id: 1,
			deleting_at: null,
		}),
	])
})

test('deleteUserAccount fails closed when REPO_SESSION_INDEX is missing', async () => {
	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com', stable_user_id: 'user-aaa' }],
		mcp_memories: [{ id: 'memory-a', user_id: 'user-aaa' }],
	})
	const env = createSuccessfulDeletionEnv(db)
	const envWithoutIndex = { ...env }
	delete envWithoutIndex.REPO_SESSION_INDEX
	await expect(
		deleteUserAccount({
			env: envWithoutIndex,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toBeInstanceOf(AccountDeletionInventoryError)
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			email: 'a@example.com',
			deleting_at: null,
		}),
	])
	expect(rows.mcp_memories).toEqual([{ id: 'memory-a', user_id: 'user-aaa' }])
})

test('deleteUserAccount fails closed when preflight inventory cannot be read', async () => {
	const { db, rows } = createTestDb(
		{
			users: [{ id: 1, email: 'a@example.com', stable_user_id: 'user-aaa' }],
			mcp_memories: [{ id: 'memory-a', user_id: 'user-aaa' }],
			jobs: [{ id: 'job-a', user_id: 'user-aaa', storage_id: 'job:job-a' }],
		},
		{ failSelectContaining: 'select id from mcp_memories where user_id = ?' },
	)
	const deleteVectors = vi.fn(async () => undefined)
	const clearStorage = vi.fn(async () => undefined)
	const userMeter = createInMemoryUserMeterEnv()
	await expect(
		deleteUserAccount({
			env: {
				APP_DB: db,
				USER_METER: userMeter.env.USER_METER,
				CAPABILITY_VECTOR_INDEX: { deleteByIds: deleteVectors },
				STORAGE_RUNNER: {
					idFromName: (name: string) => name as unknown as DurableObjectId,
					get: () => ({ clearStorage }),
				},
			} as unknown as Parameters<typeof deleteUserAccount>[0]['env'],
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toBeInstanceOf(AccountDeletionInventoryError)
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			email: 'a@example.com',
			deleting_at: null,
		}),
	])
	expect(rows.mcp_memories).toEqual([{ id: 'memory-a', user_id: 'user-aaa' }])
	expect(rows.jobs).toEqual([
		{ id: 'job-a', user_id: 'user-aaa', storage_id: 'job:job-a' },
	])
	expect(deleteVectors).not.toHaveBeenCalled()
	expect(clearStorage).not.toHaveBeenCalled()
})

test('atomic D1 deletion rolls back every row when one statement fails', async () => {
	const { db, rows } = createTestDb(
		{
			users: [{ id: 1, email: 'a@example.com' }],
			secret_buckets: [{ id: 'sb-a', user_id: 'user-aaa' }],
			mcp_memories: [{ id: 'memory-a', user_id: 'user-aaa' }],
		},
		{ failRunContaining: 'delete from mcp_memories where user_id = ?' },
	)
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toMatchObject({
		cleanupErrors: [
			expect.stringContaining('Atomic D1 account deletion failed'),
		],
	})
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			email: 'a@example.com',
			deleting_at: expect.any(String),
		}),
	])
	expect(rows.secret_buckets).toEqual([{ id: 'sb-a', user_id: 'user-aaa' }])
	expect(rows.mcp_memories).toEqual([{ id: 'memory-a', user_id: 'user-aaa' }])
})

test('account deletion quiesces a concurrent user write before inventory', async () => {
	let env: Parameters<typeof deleteUserAccount>[0]['env']
	let raceAttempted = false
	let writeCommitted = false
	let writeError: unknown
	const { db } = createTestDb(
		{
			users: [
				{
					id: 1,
					email: 'a@example.com',
					stable_user_id: 'user-aaa',
					updated_at: '2026-07-22',
				},
			],
		},
		{
			async onSelect(query) {
				if (
					raceAttempted ||
					!query.includes('select id from mcp_memories where user_id = ?')
				) {
					return
				}
				raceAttempted = true
				try {
					await assertAccountWritable(env, 'user-aaa')
					writeCommitted = true
				} catch (error) {
					writeError = error
				}
			},
		},
	)
	env = createSuccessfulDeletionEnv(db)
	await deleteUserAccount({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(raceAttempted).toBe(true)
	expect(writeCommitted).toBe(false)
	expect(writeError).toBeInstanceOf(AccountDeletionInProgressError)
})

test('account deletion waits for an active writer and resumes on retry', async () => {
	const { db, rows } = createTestDb({
		users: [
			{
				id: 1,
				email: 'a@example.com',
				stable_user_id: 'user-aaa',
				updated_at: '2026-07-22',
			},
		],
	})
	// Set up a UserMeter with an active write lease to simulate a crashed writer.
	const userMeter = createInMemoryUserMeterEnv()
	const meterStub = userMeterRpc({ env: userMeter.env, userId: 'user-aaa' })
	await meterStub.acquireWriteLease({
		token: 'crashed-token-aaa',
		holder: 'test:crashed-writer',
		acquiredAt: '2000-01-01 00:00:00',
	})
	const env = createSuccessfulDeletionEnv(db, {
		USER_METER: userMeter.env.USER_METER,
	})
	await expect(
		deleteUserAccount({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toBeInstanceOf(AccountDeletionWritersActiveError)
	expect(rows.users?.[0]).toEqual(
		expect.objectContaining({
			deleting_at: null,
		}),
	)
	// Release the meter lease to simulate the crashed writer being repaired.
	await meterStub.releaseWriteLease({ token: 'crashed-token-aaa' })
	await expect(
		deleteUserAccount({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).resolves.toEqual(expect.objectContaining({ warnings: [] }))
	expect(rows.users).toEqual([])
})

test('account deletion empties the user RunLog DO and leaves other users untouched', async () => {
	const userAaa = 'user-aaa'
	const userBbb = 'user-bbb'
	const runLogByUser = new Map<
		string,
		{
			runs: Array<{ id: string; storageId: string | null }>
			logs: Array<{ runId: string; message: string }>
		}
	>([
		[
			userAaa,
			{
				runs: [{ id: 'run-a', storageId: 'run-only-bucket' }],
				logs: [{ runId: 'run-a', message: 'aaa console output' }],
			},
		],
		[
			userBbb,
			{
				runs: [{ id: 'run-b', storageId: 'bbb-bucket' }],
				logs: [{ runId: 'run-b', message: 'bbb console output' }],
			},
		],
	])
	const clearedStorageIds: Array<string> = []
	const { db } = createTestDb({
		users: [
			{ id: 1, email: 'a@example.com', stable_user_id: userAaa },
			{ id: 2, email: 'b@example.com', stable_user_id: userBbb },
		],
	})
	const env = createSuccessfulDeletionEnv(db, {
		STORAGE_RUNNER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: (id: DurableObjectId) => ({
				clearStorage: async () => {
					clearedStorageIds.push(String(id))
					return { ok: true as const }
				},
			}),
		},
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: (id: DurableObjectId) => {
				const userId = String(id)
				return {
					listStorageIds: async () => {
						const state = runLogByUser.get(userId)
						return (state?.runs ?? [])
							.map((run) => run.storageId)
							.filter((value): value is string => value != null)
					},
					clearAll: async () => {
						const state = runLogByUser.get(userId)
						if (state) {
							state.runs = []
							state.logs = []
						}
						return { ok: true as const }
					},
					exportRuns: async () => {
						const state = runLogByUser.get(userId) ?? {
							runs: [],
							logs: [],
						}
						return {
							runs: state.runs,
							logs: state.logs,
							nextStartAfter: null,
							truncated: false,
						}
					},
				}
			},
		},
	})

	const result = await deleteUserAccount({
		env,
		dbUserId: 1,
		mcpUserId: userAaa,
	})

	expect(result.clearedDurableObjects.runLogs).toBe(1)
	expect(runLogByUser.get(userAaa)).toEqual({ runs: [], logs: [] })
	expect(runLogByUser.get(userBbb)).toEqual({
		runs: [{ id: 'run-b', storageId: 'bbb-bucket' }],
		logs: [{ runId: 'run-b', message: 'bbb console output' }],
	})
	expect(clearedStorageIds.some((id) => id.includes('run-only-bucket'))).toBe(
		true,
	)
	expect(clearedStorageIds.some((id) => id.includes('bbb-bucket'))).toBe(false)
})

test('account deletion purges a StorageRunner known only via user_storage_buckets', async () => {
	const userId = 'user-bucket-only'
	const clearStorage = vi.fn(async () => ({ ok: true as const }))
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const { db } = createTestDb({
		users: [{ id: 1, email: 'bucket@example.com', stable_user_id: userId }],
		user_storage_buckets: [
			{
				user_id: userId,
				storage_id: 'exec:adhoc-only',
				kind: 'execute',
			},
		],
	})

	const result = await deleteUserAccount({
		env: createSuccessfulDeletionEnv(db, {
			STORAGE_RUNNER: {
				idFromName,
				get: () => ({ clearStorage }),
			},
		}),
		dbUserId: 1,
		mcpUserId: userId,
	})

	expect(result.clearedDurableObjects.storageRunners).toBe(1)
	expect(clearStorage).toHaveBeenCalledTimes(1)
	expect(idFromName).toHaveBeenCalledWith(
		JSON.stringify([userId, 'exec:adhoc-only']),
	)
})
