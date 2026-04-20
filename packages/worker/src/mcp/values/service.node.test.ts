import { expect, test } from 'vitest'
import {
	deleteAllAppScopedValues,
	deleteValue,
	getValue,
	listValues,
	saveValue,
} from './service.ts'
import { type ValueBucketRow, type ValueEntryRow } from './types.ts'

function createValueTestDb() {
	const buckets = new Map<string, ValueBucketRow>()
	const entries = new Map<string, ValueEntryRow>()

	function getBucketKey(userId: string, scope: string, bindingKey: string) {
		return `${userId}:${scope}:${bindingKey}`
	}

	function getEntryKey(bucketId: string, name: string) {
		return `${bucketId}:${name}`
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
								normalizedQuery.startsWith(
									'select ? as scope, ? as binding_key',
								) &&
								normalizedQuery.includes('from value_entries')
							) {
								const [scope, bindingKey, expiresAt, bucketId] =
									params as Array<string | null>
								const results = Array.from(entries.values())
									.filter((entry) => entry.bucket_id === bucketId)
									.sort((left, right) => left.name.localeCompare(right.name))
									.map((entry) => ({
										scope,
										binding_key: bindingKey,
										name: entry.name,
										description: entry.description,
										value: entry.value,
										created_at: entry.created_at,
										updated_at: entry.updated_at,
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

	return { db, buckets, entries }
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
	).rejects.toThrow('Value scope "app" is unavailable in this context.')
})

test('value service does not treat arbitrary storage ids as app scope', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db }

	await expect(
		saveValue({
			env,
			userId: 'user-123',
			scope: 'app',
			name: 'workspaceSlug',
			value: 'job-storage',
			storageContext: {
				sessionId: null,
				appId: null,
				storageId: 'job:job-123',
			},
		}),
	).rejects.toThrow('Value scope "app" is unavailable in this context.')
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
