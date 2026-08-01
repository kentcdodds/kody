import { expect, test } from 'vitest'
import { maxRestorableTextColumnBytes } from '@kody-internal/shared/backup-restore-safety.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	getStorageBindingKey,
	resolveStorageScopeOrder,
} from '#mcp/storage-bindings.ts'
import { deleteAllAppScopedValues } from '#worker/package-config-cleanup.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	createInMemoryUserMeterEnv,
	createWaitUntilDrain,
	withPatchedDbPrepare,
} from '#worker/test-support/user-meter.ts'
import { deleteValue, getValue, listValues, saveValue } from './service.ts'
import { type ValueBucketRow, type ValueEntryRow } from './types.ts'

function createValueTestDb() {
	const buckets = new Map<string, ValueBucketRow>()
	const entries = new Map<string, ValueEntryRow>()
	let listMetadataQueryCount = 0

	function getBucketKey(userId: string, scope: string, bindingKey: string) {
		return `${userId}:${scope}:${bindingKey}`
	}

	function getEntryKey(bucketId: string, name: string) {
		return `${bucketId}:${name}`
	}

	function getBucketById(bucketId: string) {
		for (const bucket of buckets.values()) {
			if (bucket.id === bucketId) return bucket
		}
		return null
	}

	function listMetadataRowsFromBuckets(input: {
		userId: string
		bucketIds: Array<string>
		now: string
	}) {
		const bucketOrder = new Map(
			input.bucketIds.map((bucketId, index) => [bucketId, index]),
		)
		const results = Array.from(entries.values())
			.map((entry) => {
				const bucket = getBucketById(entry.bucket_id)
				if (!bucket) return null
				if (bucket.user_id !== input.userId) return null
				if (!bucketOrder.has(bucket.id)) return null
				if (bucket.expires_at != null && bucket.expires_at <= input.now) {
					return null
				}
				return {
					scope: bucket.scope,
					binding_key: bucket.binding_key,
					name: entry.name,
					description: entry.description,
					value: entry.value,
					created_at: entry.created_at,
					updated_at: entry.updated_at,
					expires_at: bucket.expires_at,
					bucketId: bucket.id,
				}
			})
			.filter((row): row is NonNullable<typeof row> => row != null)
			.sort((left, right) => {
				const orderDiff =
					(bucketOrder.get(left.bucketId) ?? 0) -
					(bucketOrder.get(right.bucketId) ?? 0)
				if (orderDiff !== 0) return orderDiff
				return left.name.localeCompare(right.name)
			})
			.map(({ bucketId: _bucketId, ...row }) => row)
		return results
	}

	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (
								normalizedQuery.startsWith('select') &&
								normalizedQuery.includes('from value_buckets')
							) {
								const [userId, scope, bindingKey, now] = params as Array<string>
								const bucket =
									buckets.get(getBucketKey(userId, scope, bindingKey)) ?? null
								if (
									bucket &&
									(bucket.expires_at == null || bucket.expires_at > now)
								) {
									return { ...bucket } as T
								}
								return null
							}
							if (
								normalizedQuery.startsWith('select') &&
								normalizedQuery.includes('from value_entries') &&
								normalizedQuery.includes('where bucket_id = ? and name = ?')
							) {
								const [bucketId, name] = params as Array<string>
								const entry = entries.get(getEntryKey(bucketId, name)) ?? null
								return entry ? ({ ...entry } as T) : null
							}
							return null
						},
						async all<T>() {
							if (
								normalizedQuery.includes('from value_entries e') &&
								normalizedQuery.includes('inner join value_buckets b')
							) {
								listMetadataQueryCount += 1
								const bucketIdCount = (params.length - 2) / 2
								const bucketIds = params.slice(
									1,
									1 + bucketIdCount,
								) as Array<string>
								const now = params[1 + bucketIdCount] as string
								const results = listMetadataRowsFromBuckets({
									userId: String(params[0]),
									bucketIds,
									now,
								})
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								normalizedQuery.startsWith(
									'select ? as scope, ? as binding_key',
								) &&
								normalizedQuery.includes('from value_entries')
							) {
								listMetadataQueryCount += 1
								const [scope, bindingKey, expiresAt, bucketId] =
									params as Array<string | null>
								const results = listMetadataRowsFromBuckets({
									userId:
										getBucketById(String(bucketId))?.user_id ?? 'unknown-user',
									bucketIds: [String(bucketId)],
									now:
										expiresAt == null ? new Date(0).toISOString() : expiresAt,
								}).map((row) => ({
									...row,
									scope,
									binding_key: bindingKey,
									expires_at: expiresAt,
								}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async run() {
							if (normalizedQuery.startsWith('insert into value_buckets')) {
								const [
									id,
									userId,
									scope,
									bindingKey,
									expiresAt,
									createdAt,
									updatedAt,
								] = params as Array<string | null>
								const key = getBucketKey(
									String(userId),
									String(scope),
									String(bindingKey),
								)
								const existing = buckets.get(key)
								buckets.set(key, {
									id: existing?.id ?? String(id),
									user_id: String(userId),
									scope: String(scope) as ValueBucketRow['scope'],
									binding_key: String(bindingKey),
									expires_at: expiresAt == null ? null : String(expiresAt),
									created_at: existing?.created_at ?? String(createdAt),
									updated_at: String(updatedAt),
								})
								return { meta: { changes: 1 } }
							}
							if (normalizedQuery.startsWith('insert into value_entries')) {
								const [
									bucketId,
									name,
									description,
									value,
									createdAt,
									updatedAt,
								] = params as Array<string>
								const key = getEntryKey(bucketId, name)
								const existing = entries.get(key)
								entries.set(key, {
									bucket_id: bucketId,
									name,
									description,
									value,
									created_at: existing?.created_at ?? createdAt,
									updated_at: updatedAt,
								})
								return { meta: { changes: 1 } }
							}
							if (
								normalizedQuery.startsWith(
									'delete from value_buckets where user_id = ? and scope = ? and binding_key = ?',
								)
							) {
								const [userId, scope, bindingKey] = params as Array<string>
								const bucketKey = getBucketKey(userId, scope, bindingKey)
								const bucket = buckets.get(bucketKey)
								if (!bucket) {
									return { meta: { changes: 0 } }
								}
								buckets.delete(bucketKey)
								for (const [entryKey, entry] of entries) {
									if (entry.bucket_id === bucket.id) {
										entries.delete(entryKey)
									}
								}
								return { meta: { changes: 1 } }
							}
							if (normalizedQuery.startsWith('delete from value_entries')) {
								const [bucketId, name] = params as Array<string>
								const deleted = entries.delete(getEntryKey(bucketId, name))
								return { meta: { changes: deleted ? 1 : 0 } }
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return {
		db,
		buckets,
		entries,
		get listMetadataQueryCount() {
			return listMetadataQueryCount
		},
	}
}

test('value service respects storage context precedence and deletion', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db }
	const storageContext = {
		sessionId: 'session-123',
		appId: 'app-123',
	}

	await saveValue({
		env,
		userId: 'user-123',
		scope: 'user',
		name: 'workspaceSlug',
		value: 'global-workspace',
		description: 'Global workspace slug',
	})
	await saveValue({
		env,
		userId: 'user-123',
		scope: 'app',
		name: 'workspaceSlug',
		value: 'app-workspace',
		description: 'App workspace slug',
		storageContext,
	})
	await saveValue({
		env,
		userId: 'user-123',
		scope: 'session',
		name: 'workspaceSlug',
		value: 'session-workspace',
		description: 'Session workspace slug',
		storageContext,
		sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
	})

	expect(
		await getValue({
			env,
			userId: 'user-123',
			name: 'workspaceSlug',
			storageContext,
		}),
	).toMatchObject({
		scope: 'session',
		value: 'session-workspace',
	})
	expect(
		await getValue({
			env,
			userId: 'user-123',
			name: 'workspaceSlug',
			scope: 'app',
			storageContext,
		}),
	).toMatchObject({
		scope: 'app',
		value: 'app-workspace',
	})

	const listed = await listValues({
		env,
		userId: 'user-123',
		storageContext,
	})
	expect(listed.map((value) => `${value.scope}:${value.value}`)).toEqual([
		'session:session-workspace',
		'app:app-workspace',
		'user:global-workspace',
	])

	expect(
		await deleteValue({
			env,
			userId: 'user-123',
			name: 'workspaceSlug',
			scope: 'session',
			storageContext,
		}),
	).toBe(true)

	expect(
		await getValue({
			env,
			userId: 'user-123',
			name: 'workspaceSlug',
			storageContext,
		}),
	).toMatchObject({
		scope: 'app',
		value: 'app-workspace',
	})
})

test('value service rejects unavailable scoped storage', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db }

	await expect(
		saveValue({
			env,
			userId: 'user-123',
			scope: 'app',
			name: 'workspaceSlug',
			value: 'missing-app',
			storageContext: {
				sessionId: 'session-123',
				appId: null,
			},
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message === 'Value scope "app" is unavailable in this context.',
	)

	await expect(
		saveValue({
			env,
			userId: 'user-123',
			scope: 'session',
			name: 'workspaceSlug',
			value: 'missing-session',
			storageContext: {
				sessionId: null,
				appId: null,
			},
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message === 'Value scope "session" is unavailable in this context.',
	)
})

test('value service rejects app scope when only storageId is bound', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db }
	const storageContext = {
		sessionId: null,
		appId: null,
		storageId: 'job:job-123',
	}

	expect(getStorageBindingKey('app', storageContext)).toBeNull()
	expect(resolveStorageScopeOrder(storageContext)).toEqual(['user'])

	await expect(
		saveValue({
			env,
			userId: 'user-123',
			scope: 'app',
			name: 'workspaceSlug',
			value: 'job-scratch-as-app',
			storageContext,
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message === 'Value scope "app" is unavailable in this context.',
	)
})

test('value service cannot read legacy app buckets keyed by storageId', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db }
	const storageContext = {
		sessionId: null,
		appId: null,
		storageId: 'job:job-123',
	}
	const now = new Date().toISOString()
	const bucketId = 'legacy-job-app-bucket'
	testDb.buckets.set('user-123:app:job:job-123', {
		id: bucketId,
		user_id: 'user-123',
		scope: 'app',
		binding_key: 'job:job-123',
		expires_at: null,
		created_at: now,
		updated_at: now,
	})
	testDb.entries.set(`${bucketId}:workspaceSlug`, {
		bucket_id: bucketId,
		name: 'workspaceSlug',
		description: 'Legacy job-keyed app value',
		value: 'stranded-job-value',
		created_at: now,
		updated_at: now,
	})

	expect(resolveStorageScopeOrder(storageContext)).toEqual(['user'])
	expect(
		await getValue({
			env,
			userId: 'user-123',
			name: 'workspaceSlug',
			storageContext,
		}),
	).toBeNull()
	expect(
		await getValue({
			env,
			userId: 'user-123',
			name: 'workspaceSlug',
			scope: 'app',
			storageContext,
		}),
	).toBeNull()
	expect(
		await listValues({
			env,
			userId: 'user-123',
			storageContext,
		}),
	).toEqual([])
})

test('value service rejects values too large for restorable D1 backups', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db }

	await expect(
		saveValue({
			env,
			userId: 'user-123',
			scope: 'user',
			name: 'giantHistoryCache',
			value: 'x'.repeat(maxRestorableTextColumnBytes + 1),
			storageContext: { sessionId: null, appId: null },
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes('too large to store'),
	)

	// A value at the limit is accepted.
	const saved = await saveValue({
		env,
		userId: 'user-123',
		scope: 'user',
		name: 'largeButRestorable',
		value: 'x'.repeat(maxRestorableTextColumnBytes),
		storageContext: { sessionId: null, appId: null },
	})
	expect(saved.name).toBe('largeButRestorable')
})

test('deleteAllAppScopedValues removes all app-scoped values for one app', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db }

	await saveValue({
		env,
		userId: 'user-123',
		scope: 'app',
		name: 'token',
		value: 'app-one',
		storageContext: {
			sessionId: null,
			appId: 'app-1',
		},
	})
	await saveValue({
		env,
		userId: 'user-123',
		scope: 'app',
		name: 'token',
		value: 'app-two',
		storageContext: {
			sessionId: null,
			appId: 'app-2',
		},
	})

	await expect(
		deleteAllAppScopedValues({
			env,
			userId: 'user-123',
			appId: 'app-1',
		}),
	).resolves.toBe(true)

	await expect(
		getValue({
			env,
			userId: 'user-123',
			name: 'token',
			scope: 'app',
			storageContext: {
				sessionId: null,
				appId: 'app-1',
			},
		}),
	).resolves.toBeNull()

	await expect(
		getValue({
			env,
			userId: 'user-123',
			name: 'token',
			scope: 'app',
			storageContext: {
				sessionId: null,
				appId: 'app-2',
			},
		}),
	).resolves.toMatchObject({
		value: 'app-two',
	})
})

test('listValues uses one metadata query across buckets and preserves ordering', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db }
	const storageContext = {
		sessionId: 'session-456',
		appId: 'app-456',
	}

	await saveValue({
		env,
		userId: 'user-456',
		scope: 'user',
		name: 'zebra',
		value: 'user-zebra',
	})
	await saveValue({
		env,
		userId: 'user-456',
		scope: 'user',
		name: 'alpha',
		value: 'user-alpha',
	})
	await saveValue({
		env,
		userId: 'user-456',
		scope: 'app',
		name: 'beta',
		value: 'app-beta',
		storageContext,
	})
	await saveValue({
		env,
		userId: 'user-456',
		scope: 'session',
		name: 'gamma',
		value: 'session-gamma',
		storageContext,
		sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
	})

	const metadataQueriesBefore = testDb.listMetadataQueryCount
	const listed = await listValues({
		env,
		userId: 'user-456',
		storageContext,
	})

	expect(testDb.listMetadataQueryCount - metadataQueriesBefore).toBe(1)
	expect(
		listed.map((value) => `${value.scope}:${value.name}:${value.value}`),
	).toEqual([
		'session:gamma:session-gamma',
		'app:beta:app-beta',
		'user:alpha:user-alpha',
		'user:zebra:user-zebra',
	])

	await deleteValue({
		env,
		userId: 'user-456',
		name: 'beta',
		scope: 'app',
		storageContext,
	})
	expect(
		(
			await listValues({
				env,
				userId: 'user-456',
				storageContext,
			})
		).map((value) => `${value.scope}:${value.name}`),
	).toEqual(['session:gamma', 'user:alpha', 'user:zebra'])
	expect(
		await listValues({
			env,
			userId: 'user-missing',
			storageContext,
		}),
	).toEqual([])
})

test('saveValue permits underscore-prefixed ordinary value names', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db }

	const saved = await saveValue({
		env,
		userId: 'user-platform',
		scope: 'user',
		name: '_scratch:widgets',
		value: '{"provider":"widgets"}',
		description: 'Scratch widgets config',
	})

	expect(saved).toMatchObject({
		name: '_scratch:widgets',
		value: '{"provider":"widgets"}',
		scope: 'user',
	})
	expect(
		await getValue({
			env,
			userId: 'user-platform',
			name: '_scratch:widgets',
			scope: 'user',
		}),
	).toMatchObject({
		name: '_scratch:widgets',
		value: '{"provider":"widgets"}',
	})
})

test('saveValue awaits atomic D1 storage reserve; D1→UserMeter shadow is deferred and non-blocking', async () => {
	const testDb = createValueTestDb()
	const meter = createInMemoryUserMeterEnv()
	const drain = createWaitUntilDrain()
	const userId = 'a'.repeat(64)
	const email = 'value-storage@example.com'
	let d1StorageBytes = 100
	let failShadowPointRead = false
	await meter.seedStorageBytes({ userId, bytes: 7 })

	let releaseShadowRead!: () => void
	const shadowReadGate = new Promise<void>((resolve) => {
		releaseShadowRead = resolve
	})
	let shadowPointReadStarted = false
	let atomicReserveCompleted = false
	using _patch = withPatchedDbPrepare(testDb.db, (originalPrepare) => {
		return ((query: string) => {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			const statement = originalPrepare(query)
			const originalBind = statement.bind.bind(statement)
			return {
				bind(...params: Array<unknown>) {
					const bound = originalBind(...params)
					return {
						first: async <T>() => {
							if (
								normalized.includes('select plan, stripe_plan from users') &&
								normalized.includes('stable_user_id')
							) {
								return { plan: 'pro', stripe_plan: null } as T
							}
							if (
								normalized.includes('select d1_storage_bytes as bytes') &&
								normalized.includes('from users')
							) {
								if (failShadowPointRead) {
									throw new Error('forced D1→UserMeter shadow read failure')
								}
								shadowPointReadStarted = true
								await shadowReadGate
								return { bytes: d1StorageBytes } as T
							}
							return await bound.first<T>()
						},
						all: bound.all.bind(bound),
						raw: bound.raw?.bind(bound),
						run: async () => {
							if (
								normalized.includes(
									'set d1_storage_bytes = d1_storage_bytes + ?',
								)
							) {
								const requested = Number(params[0])
								const limit = Number(params[4])
								if (d1StorageBytes + requested <= limit) {
									d1StorageBytes += requested
									atomicReserveCompleted = true
									return { meta: { changes: 1 } }
								}
								return { meta: { changes: 0 } }
							}
							return await bound.run()
						},
					}
				},
			}
		}) as D1Database['prepare']
	})

	const env = { APP_DB: testDb.db, ...meter.env }
	const saved = await saveValue({
		env,
		userId,
		userEmail: email,
		scope: 'user',
		name: 'metered-value',
		value: 'hello-storage',
		waitUntil: drain.waitUntil,
	})
	expect(saved).toMatchObject({ name: 'metered-value' })
	expect(atomicReserveCompleted).toBe(true)
	expect(d1StorageBytes).toBeGreaterThan(100)
	expect(shadowPointReadStarted).toBe(true)
	expect(await userMeterRpc({ env, userId }).readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: 7,
	})

	releaseShadowRead()
	await drain.drain()
	expect(await userMeterRpc({ env, userId }).readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: d1StorageBytes,
	})

	failShadowPointRead = true
	consoleWarn.mockImplementation(() => {})
	const failingDrain = createWaitUntilDrain()
	const bytesBeforeFailingSave = d1StorageBytes
	await expect(
		saveValue({
			env,
			userId,
			userEmail: email,
			scope: 'user',
			name: 'metered-value-2',
			value: 'still-ok',
			waitUntil: failingDrain.waitUntil,
		}),
	).resolves.toMatchObject({ name: 'metered-value-2' })
	expect(d1StorageBytes).toBeGreaterThan(bytesBeforeFailingSave)
	await failingDrain.drain()
	expect(consoleWarn).toHaveBeenCalledWith(
		'entitlement-storage-bytes-shadow-failed',
		expect.any(Error),
	)
})
