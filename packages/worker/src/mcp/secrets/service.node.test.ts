import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	listPackageSecretsByPackageIds,
	resolveSecret,
	saveSecret,
	setSecretAllowedPackages,
	setSecretsAtomically,
	updateUserSecretForPackage,
	updateUserSecretsForPackageAtomically,
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
	initialRows: {
		users?: Array<{ email: string; plan: string | null }>
		/** Pre-seeded secret count for entitlement ceiling tests (avoids loops). */
		seededSecretCount?: number
		seededSecretUserId?: string
	} = {},
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

	const seededCount = initialRows.seededSecretCount ?? 0
	const seededUserId = initialRows.seededSecretUserId
	if (seededCount > 0 && seededUserId) {
		const now = '2026-04-18T00:00:00.000Z'
		const bucketId = `seeded-bucket-${seededUserId}`
		buckets.set(getBucketKey(seededUserId, 'user', ''), {
			id: bucketId,
			user_id: seededUserId,
			scope: 'user',
			binding_key: '',
			expires_at: null,
			created_at: now,
			updated_at: now,
		})
		for (let index = 0; index < seededCount; index += 1) {
			const name = `seeded-secret-${index}`
			entries.set(getEntryKey(bucketId, name), {
				bucket_id: bucketId,
				name,
				description: '',
				encrypted_value: `seeded-value-${index}`,
				allowed_hosts: '[]',
				allowed_capabilities: '[]',
				allowed_packages: '[]',
				created_at: now,
				updated_at: now,
			})
		}
	}

	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					const statement = {
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
								normalizedQuery.includes(
									'update secret_entries set description = case name',
								)
							) {
								// Multi-secret atomic CASE update bind order:
								// [name, description]*N, [name, encrypted]*N, updatedAt,
								// names*N, userId, packageId, userId, names*N, packageId, expectedCount
								const expectedCount = Number(params[params.length - 1])
								const packageId = String(params[params.length - 2])
								const namesStart = expectedCount * 4 + 1
								const names = params
									.slice(namesStart, namesStart + expectedCount)
									.map(String)
								const userId = String(params[namesStart + expectedCount])
								const updatedAt = String(params[expectedCount * 4])
								const descriptions = new Map<string, string>()
								const encryptedValues = new Map<string, string>()
								for (let index = 0; index < expectedCount; index += 1) {
									descriptions.set(
										String(params[index * 2]),
										String(params[index * 2 + 1]),
									)
									encryptedValues.set(
										String(params[expectedCount * 2 + index * 2]),
										String(params[expectedCount * 2 + index * 2 + 1]),
									)
								}
								const bucket = buckets.get(getBucketKey(userId, 'user', ''))
								if (!bucket) return { meta: { changes: 0 } }
								let approvedCount = 0
								for (const name of names) {
									const entry = entries.get(getEntryKey(bucket.id, name))
									if (!entry) continue
									const allowedPackages = JSON.parse(
										entry.allowed_packages,
									) as Array<string>
									if (allowedPackages.includes(packageId)) {
										approvedCount += 1
									}
								}
								if (approvedCount !== expectedCount) {
									return { meta: { changes: 0 } }
								}
								for (const name of names) {
									const entry = entries.get(getEntryKey(bucket.id, name))
									if (!entry) continue
									entry.description =
										descriptions.get(name) ?? entry.description
									entry.encrypted_value =
										encryptedValues.get(name) ?? entry.encrypted_value
									entry.updated_at = updatedAt
								}
								return { meta: { changes: expectedCount } }
							}
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
					return statement
				},
			}
		},
		async batch(
			statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>,
		) {
			const snapshotBuckets = new Map(
				Array.from(buckets.entries()).map(([key, value]) => [
					key,
					{ ...value },
				]),
			)
			const snapshotEntries = new Map(
				Array.from(entries.entries()).map(([key, value]) => [
					key,
					{ ...value },
				]),
			)
			try {
				const results = []
				for (const statement of statements) {
					results.push(await statement.run())
				}
				return results
			} catch (error) {
				buckets.clear()
				for (const [key, value] of snapshotBuckets) {
					buckets.set(key, value)
				}
				entries.clear()
				for (const [key, value] of snapshotEntries) {
					entries.set(key, value)
				}
				throw error
			}
		},
	} as unknown as D1Database

	function corruptUserSecret(userId: string, name: string) {
		const bucket = buckets.get(getBucketKey(userId, 'user', ''))
		if (!bucket) throw new Error('user bucket not found')
		const entry = entries.get(getEntryKey(bucket.id, name))
		if (!entry) throw new Error('secret entry not found')
		entry.encrypted_value = 'not-valid-ciphertext'
	}

	return { db, corruptUserSecret }
}

test('resolveSecret returns the first scope hit in precedence order', async () => {
	const testDb = createSecretTestDb()
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
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

test('saveSecret rejects unavailable scoped storage as McpCallerError', async () => {
	const testDb = createSecretTestDb()
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	}

	await expect(
		saveSecret({
			env,
			userId: 'user-123',
			scope: 'session',
			name: 'token',
			value: 'missing-session',
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: null,
			},
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message ===
				'Secret scope "session" is unavailable in this context.',
	)

	await expect(
		saveSecret({
			env,
			userId: 'user-123',
			scope: 'package',
			name: 'token',
			value: 'missing-package',
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: null,
			},
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message ===
				'Secret scope "package" is unavailable in this context.',
	)
})

test('listPackageSecretsByPackageIds groups package-owned secrets', async () => {
	const testDb = createSecretTestDb()
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
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
		...createInMemoryUserMeterEnv().env,
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
	).rejects.toThrow('not approved for package "package-2"')
})

test('setSecretsAtomically persists refresh then access tokens together for package grants', async () => {
	const testDb = createSecretTestDb()
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	}
	await saveSecret({
		env,
		userId: 'user-123',
		scope: 'user',
		name: 'xRefreshToken',
		value: 'old-refresh',
	})
	await saveSecret({
		env,
		userId: 'user-123',
		scope: 'user',
		name: 'xAccessToken',
		value: 'old-access',
	})
	await setSecretAllowedPackages({
		env,
		userId: 'user-123',
		scope: 'user',
		name: 'xRefreshToken',
		allowedPackages: ['package-1'],
	})
	await setSecretAllowedPackages({
		env,
		userId: 'user-123',
		scope: 'user',
		name: 'xAccessToken',
		allowedPackages: ['package-1'],
	})

	await setSecretsAtomically({
		env,
		userId: 'user-123',
		secrets: [
			{ name: 'xRefreshToken', value: 'new-refresh', scope: 'user' },
			{ name: 'xAccessToken', value: 'new-access', scope: 'user' },
		],
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: 'package-1',
			storageId: null,
		},
	})

	await expect(
		resolveSecret({
			env,
			userId: 'user-123',
			scope: 'user',
			name: 'xRefreshToken',
		}),
	).resolves.toMatchObject({ found: true, value: 'new-refresh' })
	await expect(
		resolveSecret({
			env,
			userId: 'user-123',
			scope: 'user',
			name: 'xAccessToken',
		}),
	).resolves.toMatchObject({ found: true, value: 'new-access' })
})

test('updateUserSecretsForPackageAtomically leaves both secrets unchanged when any grant is missing', async () => {
	const testDb = createSecretTestDb()
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	}
	await saveSecret({
		env,
		userId: 'user-123',
		scope: 'user',
		name: 'xRefreshToken',
		value: 'old-refresh',
	})
	await saveSecret({
		env,
		userId: 'user-123',
		scope: 'user',
		name: 'xAccessToken',
		value: 'old-access',
	})
	await setSecretAllowedPackages({
		env,
		userId: 'user-123',
		scope: 'user',
		name: 'xRefreshToken',
		allowedPackages: ['package-1'],
	})
	// Access token deliberately has no package grant.

	await expect(
		updateUserSecretsForPackageAtomically({
			env,
			userId: 'user-123',
			packageId: 'package-1',
			secrets: [
				{ name: 'xRefreshToken', value: 'new-refresh' },
				{ name: 'xAccessToken', value: 'new-access' },
			],
		}),
	).rejects.toThrow('not approved for package "package-1"')

	await expect(
		resolveSecret({
			env,
			userId: 'user-123',
			scope: 'user',
			name: 'xRefreshToken',
		}),
	).resolves.toMatchObject({ found: true, value: 'old-refresh' })
	await expect(
		resolveSecret({
			env,
			userId: 'user-123',
			scope: 'user',
			name: 'xAccessToken',
		}),
	).resolves.toMatchObject({ found: true, value: 'old-access' })
})

test('resolveSecret ignores a corrupted lower-precedence entry when a higher scope resolves', async () => {
	const testDb = createSecretTestDb()
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
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
	seededSecretCount?: number
	seededSecretUserId?: string
}) {
	const testDb = createSecretTestDb({
		users: [{ email: input.email, plan: input.plan }],
		seededSecretCount: input.seededSecretCount,
		seededSecretUserId: input.seededSecretUserId,
	})
	return {
		testDb,
		env: {
			APP_DB: testDb.db,
			COOKIE_SECRET: 'test-cookie-secret',
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
			...createInMemoryUserMeterEnv().env,
		},
	}
}

test('saveSecret enforces plan secret quotas including updates and max ceiling', async () => {
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

	const overLimit = await saveSecret({
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
	if (!isEntitlementLimitError(overLimit)) {
		throw new Error('Expected an EntitlementLimitError from saveSecret.')
	}
	expect(overLimit.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'secrets',
		plan: 'pro',
		limit,
		current: limit,
	})

	const updated = await saveSecret({
		env,
		userId,
		userEmail: email,
		scope: 'user',
		name: 'quota-secret-0',
		value: 'rotated-value',
		description: 'rotated',
	})
	expect(updated).toMatchObject({
		name: 'quota-secret-0',
		description: 'rotated',
	})

	const maxEmail = 'max@example.com'
	const maxUserId = await createStableUserIdFromEmail(maxEmail)
	const maxLimit = planLimits.max.maxSecrets
	const belowMax = buildEntitlementTestSecretEnv({
		email: maxEmail,
		plan: 'max',
		seededSecretCount: planLimits.pro.maxSecrets + 1,
		seededSecretUserId: maxUserId,
	})
	await saveSecret({
		env: belowMax.env,
		userId: maxUserId,
		userEmail: maxEmail,
		scope: 'user',
		name: 'below-max-secret',
		value: 'secret-value',
	})

	const atCeiling = buildEntitlementTestSecretEnv({
		email: maxEmail,
		plan: 'max',
		seededSecretCount: maxLimit,
		seededSecretUserId: maxUserId,
	})
	const ceilingError = await saveSecret({
		env: atCeiling.env,
		userId: maxUserId,
		userEmail: maxEmail,
		scope: 'user',
		name: 'over-max-secret',
		value: 'secret-value',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!isEntitlementLimitError(ceilingError)) {
		throw new Error(
			'Expected an EntitlementLimitError at the max secret ceiling.',
		)
	}
	expect(ceilingError.details).toMatchObject({
		resource: 'secrets',
		plan: 'max',
		limit: maxLimit,
		current: maxLimit,
	})
})
