import { expect, test } from 'vitest'
import { saveValue } from './service.ts'
import {
	createSkillRunnerToken,
	listSkillRunnerTokens,
	markSkillRunnerTokenUsed,
	resolveSkillRunnerUserByToken,
	revokeSkillRunnerToken,
	skillRunnerTokensValueName,
} from './skill-runner-tokens.ts'
import { type ValueBucketRow, type ValueEntryRow } from './types.ts'

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
	lookup_hash: string | null
	created_at: string
	updated_at: string
}

const skillRunnerSecretPrefix = 'skill-runner-token:'

function createValueTestDb() {
	const valueBuckets = new Map<string, ValueBucketRow>()
	const valueEntries = new Map<string, ValueEntryRow>()
	const secretBuckets = new Map<string, SecretBucketRow>()
	const secretEntries = new Map<string, SecretEntryRow>()

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
									valueBuckets.get(getBucketKey(userId, scope, bindingKey)) ?? null
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
								const entry = valueEntries.get(getEntryKey(bucketId, name)) ?? null
								return entry ? ({ ...entry } as T) : null
							}
							if (
								normalizedQuery.startsWith('select id, user_id, scope, binding_key') &&
								normalizedQuery.includes('from secret_buckets')
							) {
								const [userId, scope, bindingKey, now] = params as Array<string>
								const bucket =
									secretBuckets.get(getBucketKey(userId, scope, bindingKey)) ??
									null
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
									'select name, description, encrypted_value, created_at, updated_at from secret_entries',
								) &&
								normalizedQuery.includes('where bucket_id = ? and name = ?')
							) {
								const [bucketId, name] = params as Array<string>
								const entry = secretEntries.get(getEntryKey(bucketId, name)) ?? null
								if (!entry) return null
								return {
									name: entry.name,
									description: entry.description,
									encrypted_value: entry.encrypted_value,
									created_at: entry.created_at,
									updated_at: entry.updated_at,
								} as T
							}
							if (
								normalizedQuery.startsWith('select sb.user_id, se.name') &&
								normalizedQuery.includes('from secret_entries se inner join')
							) {
								const [lookupHash, nameLike, now] = params as Array<string>
								const prefix = nameLike.slice(0, -1)
								for (const bucket of secretBuckets.values()) {
									if (
										bucket.scope !== 'user' ||
										bucket.binding_key !== '' ||
										(bucket.expires_at != null && bucket.expires_at <= now)
									) {
										continue
									}
									for (const entry of secretEntries.values()) {
										if (entry.bucket_id !== bucket.id) continue
										if (entry.lookup_hash !== lookupHash) continue
										if (!entry.name.startsWith(prefix)) continue
										return {
											user_id: bucket.user_id,
											name: entry.name,
										} as T
									}
								}
								return null
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
								const results = Array.from(valueEntries.values())
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
							if (
								normalizedQuery.startsWith('select vb.user_id, ve.value') &&
								normalizedQuery.includes('from value_entries ve inner join')
							) {
								const [name, now] = params as Array<string>
								const results = Array.from(valueBuckets.values())
									.filter(
										(bucket) =>
											bucket.scope === 'user' &&
											bucket.binding_key === '' &&
											(bucket.expires_at == null || bucket.expires_at > now),
									)
									.flatMap((bucket) => {
										const entry = valueEntries.get(getEntryKey(bucket.id, name))
										return entry
											? [{ user_id: bucket.user_id, value: entry.value }]
											: []
									})
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								normalizedQuery.startsWith(
									'select name, description, encrypted_value, created_at, updated_at from secret_entries',
								) &&
								normalizedQuery.includes('where bucket_id = ? and name like ?')
							) {
								const [bucketId, nameLike] = params as Array<string>
								const prefix = nameLike.slice(0, -1)
								const results = Array.from(secretEntries.values())
									.filter(
										(entry) =>
											entry.bucket_id === bucketId && entry.name.startsWith(prefix),
									)
									.sort((left, right) => left.name.localeCompare(right.name))
									.map((entry) => ({
										name: entry.name,
										description: entry.description,
										encrypted_value: entry.encrypted_value,
										created_at: entry.created_at,
										updated_at: entry.updated_at,
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
								const existing = valueBuckets.get(key)
								valueBuckets.set(key, {
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
								const existing = valueEntries.get(key)
								valueEntries.set(key, {
									bucket_id: bucketId,
									name,
									description,
									value,
									created_at: existing?.created_at ?? createdAt,
									updated_at: updatedAt,
								})
								return { meta: { changes: 1 } }
							}
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
								const existing = secretBuckets.get(key)
								secretBuckets.set(key, {
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
									lookupHash,
									createdAt,
									updatedAt,
								] = params as Array<string>
								const key = getEntryKey(bucketId, name)
								const existing = secretEntries.get(key)
								secretEntries.set(key, {
									bucket_id: bucketId,
									name,
									description,
									encrypted_value: encryptedValue,
									allowed_hosts: '[]',
									allowed_capabilities: '[]',
									lookup_hash: lookupHash,
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
								const bucket = valueBuckets.get(bucketKey)
								if (!bucket) {
									return { meta: { changes: 0 } }
								}
								valueBuckets.delete(bucketKey)
								for (const [entryKey, entry] of valueEntries) {
									if (entry.bucket_id === bucket.id) {
										valueEntries.delete(entryKey)
									}
								}
								return { meta: { changes: 1 } }
							}
							if (normalizedQuery.startsWith('delete from value_entries')) {
								const [bucketId, name] = params as Array<string>
								const deleted = valueEntries.delete(getEntryKey(bucketId, name))
								return { meta: { changes: deleted ? 1 : 0 } }
							}
							if (normalizedQuery.startsWith('delete from secret_entries')) {
								const [bucketId, name] = params as Array<string>
								const deleted = secretEntries.delete(getEntryKey(bucketId, name))
								return { meta: { changes: deleted ? 1 : 0 } }
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	function getStoredValue(userId: string, name: string) {
		const bucket = valueBuckets.get(getBucketKey(userId, 'user', ''))
		if (!bucket) return null
		return valueEntries.get(getEntryKey(bucket.id, name))?.value ?? null
	}

	function getStoredSecret(userId: string, clientName: string) {
		const bucket = secretBuckets.get(getBucketKey(userId, 'user', ''))
		if (!bucket) return null
		return (
			secretEntries.get(getEntryKey(bucket.id, `${skillRunnerSecretPrefix}${clientName}`)) ??
			null
		)
	}

	return { db, getStoredValue, getStoredSecret }
}

test('skill runner token store uses secret entries and tracks metadata usage', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db, COOKIE_SECRET: 'test-cookie-secret' }

	const created = await createSkillRunnerToken({
		env,
		userId: 'user-123',
		clientName: 'kody-discord-gateway',
		name: 'Discord Gateway',
		description: 'Receives Discord events and forwards them to Kody.',
	})

	expect(created).toMatchObject({
		name: 'Discord Gateway',
		description: 'Receives Discord events and forwards them to Kody.',
		lastUsedAt: null,
		token: expect.stringMatching(/^tok_[0-9a-f]+$/),
	})

	expect(
		testDb.getStoredValue('user-123', skillRunnerTokensValueName),
	).toBeNull()
	const storedSecret = testDb.getStoredSecret(
		'user-123',
		'kody-discord-gateway',
	)
	expect(storedSecret).toBeTruthy()
	expect(storedSecret?.encrypted_value).toBeTruthy()
	expect(storedSecret?.encrypted_value).not.toContain(created.token)
	expect(storedSecret?.lookup_hash).toMatch(/^sha256:/)

	await expect(
		resolveSkillRunnerUserByToken({
			env,
			token: created.token,
		}),
	).resolves.toEqual({
		userId: 'user-123',
		clientName: 'kody-discord-gateway',
	})

	await expect(
		listSkillRunnerTokens({
			env,
			userId: 'user-123',
		}),
	).resolves.toEqual([
		{
			clientName: 'kody-discord-gateway',
			name: 'Discord Gateway',
			description: 'Receives Discord events and forwards them to Kody.',
			lastUsedAt: null,
			token: 'tok_…',
		},
	])

	await expect(
		markSkillRunnerTokenUsed({
			env,
			userId: 'user-123',
			clientName: 'kody-discord-gateway',
		}),
	).resolves.toBe(true)

	const listedAfterUse = await listSkillRunnerTokens({
		env,
		userId: 'user-123',
	})
	expect(listedAfterUse).toEqual([
		{
			clientName: 'kody-discord-gateway',
			name: 'Discord Gateway',
			description: 'Receives Discord events and forwards them to Kody.',
			lastUsedAt: expect.any(String),
			token: 'tok_…',
		},
	])

	await expect(
		revokeSkillRunnerToken({
			env,
			userId: 'user-123',
			clientName: 'kody-discord-gateway',
		}),
	).resolves.toBe(true)

	await expect(
		listSkillRunnerTokens({
			env,
			userId: 'user-123',
		}),
	).resolves.toEqual([])
	await expect(
		resolveSkillRunnerUserByToken({
			env,
			token: created.token,
		}),
	).resolves.toBeNull()
})

test('skill runner token store migrates legacy value-backed tokens into secret entries', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db, COOKIE_SECRET: 'test-cookie-secret' }

	await saveValue({
		env,
		userId: 'legacy-user',
		name: skillRunnerTokensValueName,
		value: JSON.stringify({
			legacyGateway: 'tok_legacy_token',
		}),
		scope: 'user',
		storageContext: {
			sessionId: null,
			appId: null,
			storageId: null,
		},
	})

	await expect(
		listSkillRunnerTokens({
			env,
			userId: 'legacy-user',
		}),
	).resolves.toEqual([
		{
			clientName: 'legacyGateway',
			name: 'legacyGateway',
			description: null,
			lastUsedAt: null,
			token: 'tok_…',
		},
	])

	expect(testDb.getStoredValue('legacy-user', skillRunnerTokensValueName)).toBeNull()
	expect(testDb.getStoredSecret('legacy-user', 'legacyGateway')).toBeTruthy()

	await expect(
		resolveSkillRunnerUserByToken({
			env,
			token: 'tok_legacy_token',
		}),
	).resolves.toEqual({
		userId: 'legacy-user',
		clientName: 'legacyGateway',
	})
})
