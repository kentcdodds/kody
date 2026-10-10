import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { maxRestorableTextColumnBytes } from '@kody-internal/shared/backup-restore-safety.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	getStorageBindingKey,
	resolveStorageScopeOrder,
} from '#mcp/storage-bindings.ts'
import { deleteAllAppScopedValues } from '#worker/package-config-cleanup.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import {
	createInMemoryUserMeterEnv,
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
								const [userId, scope, bindingKey, now] = params as [
									string,
									string,
									string,
									string,
								]
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
								const [bucketId, name] = params as [string, string]
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
								] = params as [string, string, string, string, string, string]
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
								const [userId, scope, bindingKey] = params as [
									string,
									string,
									string,
								]
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
								const [bucketId, name] = params as [string, string]
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

function createValueEnv() {
	const testDb = createValueTestDb()
	const { env: meterEnv } = createInMemoryUserMeterEnv()
	return { testDb, env: { APP_DB: testDb.db, ...meterEnv } }
}

const isCallerError =
	(matches: (message: string) => boolean) => (error: unknown) =>
		error instanceof McpCallerError && matches(error.message)
const scopeUnavailable = (scope: string) =>
	isCallerError(
		(message) =>
			message === `Value scope "${scope}" is unavailable in this context.`,
	)

test('value service respects storage context precedence and deletion', async () => {
	const { env } = createValueEnv()
	const storageContext = { sessionId: 'session-123', appId: 'app-123' }
	const userId = ownerIdFromStored('user-123')
	const name = 'workspaceSlug'

	await saveValue({
		env,
		userId,
		scope: 'user',
		name,
		value: 'global-workspace',
		description: 'Global workspace slug',
	})
	await saveValue({
		env,
		userId,
		scope: 'app',
		name,
		value: 'app-workspace',
		description: 'App workspace slug',
		storageContext,
	})
	await saveValue({
		env,
		userId,
		scope: 'session',
		name,
		value: 'session-workspace',
		description: 'Session workspace slug',
		storageContext,
		sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
	})

	expect(await getValue({ env, userId, name, storageContext })).toMatchObject({
		scope: 'session',
		value: 'session-workspace',
	})
	expect(
		await getValue({ env, userId, name, scope: 'app', storageContext }),
	).toMatchObject({ scope: 'app', value: 'app-workspace' })
	const listed = await listValues({ env, userId, storageContext })
	expect(listed.map((value) => `${value.scope}:${value.value}`)).toEqual([
		'session:session-workspace',
		'app:app-workspace',
		'user:global-workspace',
	])

	expect(
		await deleteValue({ env, userId, name, scope: 'session', storageContext }),
	).toBe(true)
	expect(await getValue({ env, userId, name, storageContext })).toMatchObject({
		scope: 'app',
		value: 'app-workspace',
	})
})

test('value service rejects unavailable scoped storage and cannot read legacy app buckets keyed by storageId', async () => {
	const { testDb, env } = createValueEnv()
	const jobStorageContext = {
		sessionId: null,
		appId: null,
		storageId: 'job:job-123',
	}
	for (const [scope, storageContext] of [
		['app', { sessionId: 'session-123', appId: null }],
		['session', { sessionId: null, appId: null }],
		['app', jobStorageContext],
	] as const) {
		await expect(
			saveValue({
				env,
				userId: ownerIdFromStored('user-123'),
				scope,
				name: 'workspaceSlug',
				value: 'unavailable',
				storageContext,
			}),
		).rejects.toSatisfy(scopeUnavailable(scope))
	}
	expect(getStorageBindingKey('app', jobStorageContext)).toBeNull()
	expect(resolveStorageScopeOrder(jobStorageContext)).toEqual(['user'])

	const now = new Date().toISOString()
	const bucketId = 'legacy-job-app-bucket'
	testDb.buckets.set('user-123:app:job:job-123', {
		id: bucketId,
		user_id: ownerIdFromStored('user-123'),
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
	const lookup = {
		env,
		userId: ownerIdFromStored('user-123'),
		name: 'workspaceSlug',
		storageContext: jobStorageContext,
	}
	expect(await getValue(lookup)).toBeNull()
	expect(await getValue({ ...lookup, scope: 'app' })).toBeNull()
	expect(await listValues(lookup)).toEqual([])
})

test('value service rejects values too large for restorable D1 backups', async () => {
	const { env } = createValueEnv()
	const saveUserValue = (name: string, bytes: number) =>
		saveValue({
			env,
			userId: ownerIdFromStored('user-123'),
			scope: 'user',
			name,
			value: 'x'.repeat(bytes),
			storageContext: { sessionId: null, appId: null },
		})

	await expect(
		saveUserValue('giantHistoryCache', maxRestorableTextColumnBytes + 1),
	).rejects.toSatisfy(
		isCallerError((message) => message.includes('too large to store')),
	)
	// A value at the limit is accepted.
	const saved = await saveUserValue(
		'largeButRestorable',
		maxRestorableTextColumnBytes,
	)
	expect(saved.name).toBe('largeButRestorable')
})

test('deleteAllAppScopedValues removes all app-scoped values for one app', async () => {
	const { env } = createValueEnv()
	const appContext = (appId: string) => ({ sessionId: null, appId })
	for (const appId of ['app-1', 'app-2']) {
		await saveValue({
			env,
			userId: ownerIdFromStored('user-123'),
			scope: 'app',
			name: 'token',
			value: appId === 'app-1' ? 'app-one' : 'app-two',
			storageContext: appContext(appId),
		})
	}

	await expect(
		deleteAllAppScopedValues({
			env,
			userId: ownerIdFromStored('user-123'),
			appId: 'app-1',
		}),
	).resolves.toBe(true)
	const readToken = (appId: string) =>
		getValue({
			env,
			userId: ownerIdFromStored('user-123'),
			name: 'token',
			scope: 'app',
			storageContext: appContext(appId),
		})
	await expect(readToken('app-1')).resolves.toBeNull()
	await expect(readToken('app-2')).resolves.toMatchObject({ value: 'app-two' })
})

test('listValues uses one metadata query across buckets and preserves ordering', async () => {
	const { testDb, env } = createValueEnv()
	const storageContext = { sessionId: 'session-456', appId: 'app-456' }
	const userId = ownerIdFromStored('user-456')
	for (const [scope, name, value] of [
		['user', 'zebra', 'user-zebra'],
		['user', 'alpha', 'user-alpha'],
		['app', 'beta', 'app-beta'],
		['session', 'gamma', 'session-gamma'],
	] as const) {
		await saveValue({
			env,
			userId,
			scope,
			name,
			value,
			...(scope === 'user' ? {} : { storageContext }),
			...(scope === 'session'
				? { sessionExpiresAt: new Date(Date.now() + 60_000).toISOString() }
				: {}),
		})
	}

	const metadataQueriesBefore = testDb.listMetadataQueryCount
	const listed = await listValues({ env, userId, storageContext })
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
		userId,
		name: 'beta',
		scope: 'app',
		storageContext,
	})
	expect(
		(await listValues({ env, userId, storageContext })).map(
			(value) => `${value.scope}:${value.name}`,
		),
	).toEqual(['session:gamma', 'user:alpha', 'user:zebra'])
	expect(
		await listValues({
			env,
			userId: ownerIdFromStored('user-missing'),
			storageContext,
		}),
	).toEqual([])
})

test('saveValue permits underscore-prefixed ordinary value names', async () => {
	const { env } = createValueEnv()
	const stored = { name: '_scratch:widgets', value: '{"provider":"widgets"}' }

	await expect(
		saveValue({
			env,
			userId: ownerIdFromStored('user-platform'),
			scope: 'user',
			description: 'Scratch widgets config',
			...stored,
		}),
	).resolves.toMatchObject({ ...stored, scope: 'user' })
	await expect(
		getValue({
			env,
			userId: ownerIdFromStored('user-platform'),
			name: stored.name,
			scope: 'user',
		}),
	).resolves.toMatchObject(stored)
})

test('saveValue awaits the UserMeter atomic reserve and never writes the retired D1 mirror', async () => {
	const testDb = createValueTestDb()
	const meter = createInMemoryUserMeterEnv()
	const userId = ownerIdFromStored('a').repeat(64)
	await meter.seedStorageBytes({ userId, bytes: 7 })

	const d1StorageWrites: Array<string> = []

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
							if (normalized.includes('select 1 as present from users')) {
								return { present: 1 } as T
							}
							return await bound.first<T>()
						},
						all: bound.all.bind(bound),
						raw: bound.raw?.bind(bound),
						run: async () => {
							if (normalized.includes('d1_storage_bytes')) {
								d1StorageWrites.push(query)
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
		userId: ownerIdFromStored(userId),
		userEmail: 'value-storage@example.com',
		scope: 'user',
		name: 'metered-value',
		value: 'hello-storage',
	})
	expect(saved).toMatchObject({ name: 'metered-value' })
	// DO reserve completed synchronously.
	const meterBytesAfterReserve = await userMeterRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).readStorageBytes()
	expect(meterBytesAfterReserve).toMatchObject({ outcome: 'ready' })
	if (meterBytesAfterReserve.outcome !== 'ready')
		throw new Error('Expected ready')
	expect(meterBytesAfterReserve.bytes).toBeGreaterThan(7)
	// There is no D1 storage-bytes mirror column to write.
	expect(d1StorageWrites).toEqual([])
})
