import { expect, test } from 'vitest'
import { listSecrets, saveSecret } from './service.ts'

type SecretBucketRow = {
	id: string
	user_id: string
	scope: 'session' | 'app' | 'user'
	binding_key: string
	expires_at: string | null
	created_at: string
	updated_at: string
}

type SecretEntryRow = {
	bucket_id: string
	name: string
	description: string
	encrypted_value: string
	allowed_hosts: string
	allowed_capabilities: string
	created_at: string
	updated_at: string
}

function createSecretTestDb() {
	const buckets = new Map<string, SecretBucketRow>()
	const entries = new Map<string, SecretEntryRow>()

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
								normalizedQuery.startsWith(
									'select id, user_id, scope, binding_key',
								) &&
								normalizedQuery.includes('from secret_buckets')
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
								normalizedQuery.startsWith(
									'select bucket_id, name, description',
								) &&
								normalizedQuery.includes('from secret_entries') &&
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
									'select ? as scope, ? as binding_key, name, description, allowed_hosts, allowed_capabilities, created_at, updated_at, ? as expires_at from secret_entries',
								)
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
										allowed_hosts: entry.allowed_hosts,
										allowed_capabilities: entry.allowed_capabilities,
										created_at: entry.created_at,
										updated_at: entry.updated_at,
										expires_at: expiresAt,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async run() {
							if (normalizedQuery.startsWith('insert into secret_buckets')) {
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
									scope: String(scope) as SecretBucketRow['scope'],
									binding_key: String(bindingKey),
									expires_at: expiresAt == null ? null : String(expiresAt),
									created_at: existing?.created_at ?? String(createdAt),
									updated_at: String(updatedAt),
								})
								return { meta: { changes: 1 } }
							}
							if (normalizedQuery.startsWith('insert into secret_entries')) {
								const [
									bucketId,
									name,
									description,
									encryptedValue,
									allowedHosts,
									allowedCapabilities,
									createdAt,
									updatedAt,
								] = params as Array<string>
								const key = getEntryKey(bucketId, name)
								const existing = entries.get(key)
								entries.set(key, {
									bucket_id: bucketId,
									name,
									description,
									encrypted_value: encryptedValue,
									allowed_hosts: allowedHosts,
									allowed_capabilities: allowedCapabilities,
									created_at: existing?.created_at ?? createdAt,
									updated_at: updatedAt,
								})
								return { meta: { changes: 1 } }
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	function seedReservedSecret(userId: string, name: string) {
		const bucketKey = getBucketKey(userId, 'user', '')
		let bucket = buckets.get(bucketKey)
		if (!bucket) {
			bucket = {
				id: crypto.randomUUID(),
				user_id: userId,
				scope: 'user',
				binding_key: '',
				expires_at: null,
				created_at: '2026-01-01T00:00:00.000Z',
				updated_at: '2026-01-01T00:00:00.000Z',
			}
			buckets.set(bucketKey, bucket)
		}
		entries.set(getEntryKey(bucket.id, name), {
			bucket_id: bucket.id,
			name,
			description: 'internal',
			encrypted_value: 'ciphertext',
			allowed_hosts: '[]',
			allowed_capabilities: '[]',
			created_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-01-01T00:00:00.000Z',
		})
	}

	return { db, seedReservedSecret }
}

test('saveSecret rejects reserved internal skill runner names', async () => {
	const env = {
		APP_DB: createSecretTestDb().db,
		COOKIE_SECRET: 'test-cookie-secret',
	}

	await expect(
		saveSecret({
			env,
			userId: 'user-123',
			scope: 'user',
			name: 'skill-runner-token:discord-gateway',
			value: 'super-secret-token',
		}),
	).rejects.toThrow('Secret name is reserved for internal use.')
})

test('listSecrets hides reserved internal skill runner names', async () => {
	const testDb = createSecretTestDb()
	testDb.seedReservedSecret('user-123', 'skill-runner-token:discord-gateway')
	const env = { APP_DB: testDb.db }

	await expect(
		listSecrets({
			env,
			userId: 'user-123',
			scope: 'user',
		}),
	).resolves.toEqual([])
})
