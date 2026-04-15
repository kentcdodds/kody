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
							if (
								normalizedQuery.startsWith('select vb.user_id, ve.value') &&
								normalizedQuery.includes('from value_entries ve inner join')
							) {
								const [name, now] = params as Array<string>
								const results = Array.from(buckets.values())
									.filter(
										(bucket) =>
											bucket.scope === 'user' &&
											bucket.binding_key === '' &&
											(bucket.expires_at == null || bucket.expires_at > now),
									)
									.flatMap((bucket) => {
										const entry = entries.get(getEntryKey(bucket.id, name))
										return entry
											? [{ user_id: bucket.user_id, value: entry.value }]
											: []
									})
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

	function getStoredValue(userId: string, name: string) {
		const bucket = buckets.get(getBucketKey(userId, 'user', ''))
		if (!bucket) return null
		return entries.get(getEntryKey(bucket.id, name))?.value ?? null
	}

	return { db, getStoredValue }
}

test('skill runner token store hashes tokens and tracks metadata usage', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db }

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

	const storedValue = testDb.getStoredValue(
		'user-123',
		skillRunnerTokensValueName,
	)
	expect(storedValue).toBeTruthy()
	expect(storedValue).not.toContain(created.token)
	const storedPayload = JSON.parse(storedValue ?? '{}') as Record<
		string,
		{
			token?: string
			name?: string
			description?: string
			lastUsedAt?: string | null
		}
	>
	expect(storedPayload['kody-discord-gateway']).toMatchObject({
		token: expect.stringMatching(/^sha256:/),
		name: 'Discord Gateway',
		description: 'Receives Discord events and forwards them to Kody.',
		lastUsedAt: null,
	})

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

test('skill runner token store reads legacy plaintext tokens as metadata entries', async () => {
	const testDb = createValueTestDb()
	const env = { APP_DB: testDb.db }

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
