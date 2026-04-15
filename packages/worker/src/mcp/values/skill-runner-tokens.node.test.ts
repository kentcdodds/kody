import { expect, test } from 'vitest'
import {
	createSkillRunnerToken,
	listSkillRunnerTokens,
	markSkillRunnerTokenUsed,
	resolveSkillRunnerUserByToken,
	revokeSkillRunnerToken,
} from './skill-runner-tokens.ts'

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
								normalizedQuery.startsWith(
									'select id, user_id, scope, binding_key',
								) &&
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
								const entry =
									secretEntries.get(getEntryKey(bucketId, name)) ?? null
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
									'select name, description, encrypted_value, created_at, updated_at from secret_entries',
								) &&
								normalizedQuery.includes('where bucket_id = ? and name like ?')
							) {
								const [bucketId, nameLike] = params as Array<string>
								const prefix = nameLike.slice(0, -1)
								const results = Array.from(secretEntries.values())
									.filter(
										(entry) =>
											entry.bucket_id === bucketId &&
											entry.name.startsWith(prefix),
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
							if (normalizedQuery.startsWith('delete from secret_entries')) {
								const [bucketId, name] = params as Array<string>
								const deleted = secretEntries.delete(
									getEntryKey(bucketId, name),
								)
								return { meta: { changes: deleted ? 1 : 0 } }
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	function getStoredSecret(userId: string, clientName: string) {
		const bucket = secretBuckets.get(getBucketKey(userId, 'user', ''))
		if (!bucket) return null
		return (
			secretEntries.get(
				getEntryKey(bucket.id, `${skillRunnerSecretPrefix}${clientName}`),
			) ?? null
		)
	}

	return { db, getStoredSecret }
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
