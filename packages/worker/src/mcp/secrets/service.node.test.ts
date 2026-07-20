import { expect, test } from 'vitest'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	listPackageSecretsByPackageIds,
	listSecrets,
	resolveSecret,
	saveSecret,
	setSecretAllowedPackages,
	updateUserSecretForPackage,
} from './service.ts'

type SecretBucketRow = {
	id: string
	user_id: string
	scope: 'session' | 'package' | 'user'
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
	allowed_packages: string
	created_at: string
	updated_at: string
}

function createSecretTestDb(
	initialRows: { users?: Array<{ email: string; plan: string | null }> } = {},
) {
	const buckets = new Map<string, SecretBucketRow>()
	const entries = new Map<string, SecretEntryRow>()
	const users = new Map(
		(initialRows.users ?? []).map((row) => [row.email.toLowerCase(), row.plan]),
	)

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
								normalizedQuery.includes(
									'select plan, stripe_plan from users where email = ?',
								)
							) {
								const [email] = params as Array<string>
								const plan = users.get(String(email).toLowerCase())
								if (plan === undefined) return null
								return { plan } as T
							}
							if (
								normalizedQuery.includes('from secret_entries se') &&
								normalizedQuery.includes('join secret_buckets sb')
							) {
								const [userId, now] = params as Array<string>
								let count = 0
								for (const entry of entries.values()) {
									const bucket = Array.from(buckets.values()).find(
										(candidate) => candidate.id === entry.bucket_id,
									)
									if (
										bucket &&
										bucket.user_id === userId &&
										(bucket.expires_at == null || bucket.expires_at > now)
									) {
										count += 1
									}
								}
								return { count } as T
							}
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
								normalizedQuery.includes('from secret_buckets b') &&
								normalizedQuery.includes("b.scope = 'package'")
							) {
								const [userId, ...packageIdsAndNow] = params as Array<string>
								const packageIds = new Set(packageIdsAndNow.slice(0, -1))
								const results = Array.from(entries.values())
									.flatMap((entry) => {
										const bucket = Array.from(buckets.values()).find(
											(candidate) => candidate.id === entry.bucket_id,
										)
										if (
											!bucket ||
											bucket.user_id !== userId ||
											bucket.scope !== 'package' ||
											!packageIds.has(bucket.binding_key)
										) {
											return []
										}
										return [
											{
												scope: bucket.scope,
												binding_key: bucket.binding_key,
												name: entry.name,
												description: entry.description,
												allowed_hosts: entry.allowed_hosts,
												allowed_capabilities: entry.allowed_capabilities,
												allowed_packages: entry.allowed_packages,
												created_at: entry.created_at,
												updated_at: entry.updated_at,
												expires_at: bucket.expires_at,
											},
										]
									})
									.sort((left, right) => left.name.localeCompare(right.name))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								normalizedQuery.startsWith(
									'select ? as scope, ? as binding_key, name, description, allowed_hosts, allowed_capabilities, allowed_packages, created_at, updated_at, ? as expires_at from secret_entries',
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
										allowed_packages: entry.allowed_packages,
										created_at: entry.created_at,
										updated_at: entry.updated_at,
										expires_at: expiresAt,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async run() {
							if (
								normalizedQuery.startsWith(
									'update secret_entries set description = ?',
								)
							) {
								const [
									description,
									encryptedValue,
									updatedAt,
									name,
									userId,
									packageId,
								] = params as Array<string>
								const bucket = buckets.get(getBucketKey(userId, 'user', ''))
								const entry = bucket
									? entries.get(getEntryKey(bucket.id, name))
									: null
								const allowedPackages = entry
									? (JSON.parse(entry.allowed_packages) as Array<string>)
									: []
								if (!entry || !allowedPackages.includes(packageId)) {
									return { meta: { changes: 0 } }
								}
								entry.description = description
								entry.encrypted_value = encryptedValue
								entry.updated_at = updatedAt
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
									allowedPackages,
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
									allowed_packages: allowedPackages,
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
			allowed_packages: '[]',
			created_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-01-01T00:00:00.000Z',
		})
	}

	function corruptUserSecret(userId: string, name: string) {
		const bucket = buckets.get(getBucketKey(userId, 'user', ''))
		if (!bucket) throw new Error('user bucket not found')
		const entry = entries.get(getEntryKey(bucket.id, name))
		if (!entry) throw new Error('secret entry not found')
		entry.encrypted_value = 'not-valid-ciphertext'
	}

	return { db, seedReservedSecret, corruptUserSecret }
}

test('reserved internal skill runner secret names cannot be saved or listed', async () => {
	const testDb = createSecretTestDb()
	const env = {
		APP_DB: testDb.db,
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

	testDb.seedReservedSecret('user-123', 'skill-runner-token:discord-gateway')

	await expect(
		listSecrets({
			env,
			userId: 'user-123',
			scope: 'user',
		}),
	).resolves.toEqual([])
})

test('resolveSecret returns the first scope hit in precedence order', async () => {
	const testDb = createSecretTestDb()
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	}
	const userId = 'user-123'
	const secretName = 'shared-secret'
	const storageContext = {
		sessionId: 'session-abc',
		appId: null,
		packageId: 'package-xyz',
		storageId: 'package-xyz',
	}

	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: secretName,
		value: 'user-value',
	})
	await saveSecret({
		env,
		userId,
		scope: 'package',
		name: secretName,
		value: 'package-value',
		storageContext,
	})
	await saveSecret({
		env,
		userId,
		scope: 'session',
		name: secretName,
		value: 'session-value',
		storageContext,
		sessionExpiresAt: '2099-01-01T00:00:00.000Z',
	})

	const resolved = await resolveSecret({
		env,
		userId,
		name: secretName,
		storageContext,
	})

	expect(resolved).toEqual({
		found: true,
		value: 'session-value',
		scope: 'session',
		allowedHosts: [],
		allowedCapabilities: [],
		allowedPackages: [],
	})
})

test('listPackageSecretsByPackageIds groups package-owned secrets', async () => {
	const testDb = createSecretTestDb()
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	}
	const storageContext = {
		sessionId: null,
		appId: null,
		packageId: 'package-1',
		storageId: null,
	}
	await saveSecret({
		env,
		userId: 'user-123',
		scope: 'package',
		name: 'package-token',
		value: 'package-value',
		storageContext,
	})

	const grouped = await listPackageSecretsByPackageIds({
		env,
		userId: 'user-123',
		packageIds: ['package-1', 'package-2'],
	})

	expect(grouped.get('package-1')).toEqual([
		expect.objectContaining({
			name: 'package-token',
			scope: 'package',
			packageId: 'package-1',
		}),
	])
	expect(grouped.has('package-2')).toBe(false)
})

test('updateUserSecretForPackage atomically requires an existing package approval', async () => {
	const testDb = createSecretTestDb()
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	}
	await saveSecret({
		env,
		userId: 'user-123',
		scope: 'user',
		name: 'shared-token',
		value: 'old-value',
	})
	await setSecretAllowedPackages({
		env,
		userId: 'user-123',
		scope: 'user',
		name: 'shared-token',
		allowedPackages: ['package-1'],
	})

	await expect(
		updateUserSecretForPackage({
			env,
			userId: 'user-123',
			packageId: 'package-1',
			name: 'shared-token',
			value: 'new-value',
			description: 'Updated by package',
		}),
	).resolves.toMatchObject({
		name: 'shared-token',
		description: 'Updated by package',
		allowedPackages: ['package-1'],
	})
	await expect(
		resolveSecret({
			env,
			userId: 'user-123',
			scope: 'user',
			name: 'shared-token',
		}),
	).resolves.toMatchObject({ found: true, value: 'new-value' })
	await expect(
		updateUserSecretForPackage({
			env,
			userId: 'user-123',
			packageId: 'package-2',
			name: 'shared-token',
			value: 'unauthorized-value',
		}),
	).rejects.toThrow('is not approved for package "package-2"')
})

test('resolveSecret ignores a corrupted lower-precedence entry when a higher scope resolves', async () => {
	const testDb = createSecretTestDb()
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	}
	const userId = 'user-123'
	const secretName = 'shared-secret'
	const storageContext = {
		sessionId: 'session-abc',
		appId: null,
		packageId: 'package-xyz',
		storageId: 'package-xyz',
	}

	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: secretName,
		value: 'user-value',
	})
	await saveSecret({
		env,
		userId,
		scope: 'session',
		name: secretName,
		value: 'session-value',
		storageContext,
		sessionExpiresAt: '2099-01-01T00:00:00.000Z',
	})
	testDb.corruptUserSecret(userId, secretName)

	const resolved = await resolveSecret({
		env,
		userId,
		name: secretName,
		storageContext,
	})

	expect(resolved.found).toBe(true)
	expect(resolved.value).toBe('session-value')
	expect(resolved.scope).toBe('session')
})

function buildEntitlementTestSecretEnv(input: {
	email: string
	plan: string | null
}) {
	const testDb = createSecretTestDb({
		users: [{ email: input.email, plan: input.plan }],
	})
	return {
		testDb,
		env: {
			APP_DB: testDb.db,
			COOKIE_SECRET: 'test-cookie-secret',
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		},
	}
}

test('saveSecret enforces the secrets entitlement for plan users', async () => {
	const email = 'planned@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const { env } = buildEntitlementTestSecretEnv({ email, plan: 'pro' })
	const limit = planLimits.pro.maxSecrets
	if (limit === null) throw new Error('Expected a numeric pro secret limit.')

	for (let index = 0; index < limit; index += 1) {
		await saveSecret({
			env,
			userId,
			userEmail: email,
			scope: 'user',
			name: `quota-secret-${index}`,
			value: `secret-value-${index}`,
		})
	}

	const error = await saveSecret({
		env,
		userId,
		userEmail: email,
		scope: 'user',
		name: `quota-secret-${limit}`,
		value: 'one-too-many',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!isEntitlementLimitError(error)) {
		throw new Error('Expected an EntitlementLimitError from saveSecret.')
	}
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'secrets',
		plan: 'pro',
		limit,
		current: limit,
	})
	expect(error.message).toContain(`at most ${limit} secrets`)
})

test('saveSecret allows updating an existing secret at the plan limit', async () => {
	const email = 'planned-update@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const { env } = buildEntitlementTestSecretEnv({ email, plan: 'pro' })
	const limit = planLimits.pro.maxSecrets
	if (limit === null) throw new Error('Expected a numeric pro secret limit.')

	for (let index = 0; index < limit; index += 1) {
		await saveSecret({
			env,
			userId,
			userEmail: email,
			scope: 'user',
			name: `quota-secret-${index}`,
			value: `secret-value-${index}`,
		})
	}

	const updated = await saveSecret({
		env,
		userId,
		userEmail: email,
		scope: 'user',
		name: 'quota-secret-0',
		value: 'rotated-value',
		description: 'rotated',
	})
	expect(updated.name).toBe('quota-secret-0')
	expect(updated.description).toBe('rotated')
})

test('saveSecret stays unlimited for users without a plan', async () => {
	const email = 'legacy@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const { env } = buildEntitlementTestSecretEnv({ email, plan: null })
	const limit = planLimits.pro.maxSecrets
	if (limit === null) throw new Error('Expected a numeric pro secret limit.')

	for (let index = 0; index < limit + 1; index += 1) {
		await saveSecret({
			env,
			userId,
			userEmail: email,
			scope: 'user',
			name: `legacy-secret-${index}`,
			value: `secret-value-${index}`,
		})
	}
})
