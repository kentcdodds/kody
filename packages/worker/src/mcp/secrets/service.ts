import { McpCallerError } from '#mcp/caller-error.ts'
import {
	normalizeAllowedCapabilities,
	parseAllowedCapabilities,
	stringifyAllowedCapabilities,
} from './allowed-capabilities.ts'
import {
	normalizeAllowedPackages,
	parseAllowedPackages,
	stringifyAllowedPackages,
} from './allowed-packages.ts'
import {
	normalizeAllowedHosts,
	normalizeHost,
	parseAllowedHosts,
	stringifyAllowedHosts,
} from './allowed-hosts.ts'
import { decryptSecretValue, encryptSecretValue } from './crypto.ts'
import { assertSecretNameAllowed, isReservedSecretName } from './name-guards.ts'
import {
	getSecretBindingKey,
	resolveSecretScopeOrder,
} from './secret-bindings.ts'
import { type StorageContext } from '#mcp/storage.ts'
import {
	deleteSecretEntry,
	getSecretBucket,
	getSecretEntry,
	listPackageScopeSecretMetadata,
	listSecretMetadataForBucket,
	listUserScopeSecretMetadata,
	updateApprovedUserSecretEntriesForPackageAtomically,
	upsertSecretBucket,
	upsertSecretEntry,
	upsertSecretEntriesAtomically,
} from './repo.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	estimateEntitlementStorageEntryByteDelta,
} from '#worker/entitlements/service.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'
import { type SecretMetadata, type SecretScope } from './types.ts'

type SecretOwnerContext = {
	userId: string
	storageContext?: StorageContext | null
}

type SecretWriteEnv = Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'> & UserMeterEnv

type SaveSecretInput = SecretOwnerContext & {
	env: SecretWriteEnv
	scope: SecretScope
	name: string
	value: string
	description?: string | null
	sessionExpiresAt?: string | null
	userEmail?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}

type ListSecretsInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	scope?: SecretScope | null
}

type ResolveSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	name: string
	scope?: SecretScope | null
}

type UpdateSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	name: string
	scope: SecretScope
	value?: string | null
	description?: string | null
}

type DeleteSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	name: string
	scope: SecretScope
}

export type ResolvedSecret = {
	found: boolean
	value: string | null
	scope: SecretScope | null
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	allowedPackages: Array<string>
}

export async function saveSecret(
	input: SaveSecretInput,
): Promise<SecretMetadata> {
	const name = input.name.trim()
	if (!name) {
		throw new Error('Secret name is required.')
	}
	assertSecretNameAllowed(name)
	const value = input.value.trim()
	if (!value) {
		throw new Error('Secret value is required.')
	}
	const description = input.description?.trim() ?? ''
	const bucket = await getOrCreateSecretBucket({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
		sessionExpiresAt: input.sessionExpiresAt ?? null,
	})
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name,
	})
	if (existingEntry == null) {
		await assertWithinEntitlement({
			db: input.env.APP_DB,
			userId: input.userId,
			email: input.userEmail,
			resource: 'secrets',
		})
	}
	const encryptedValue = await encryptSecretValue(input.env, value)
	await assertWithinStorageBytesEntitlement({
		db: input.env.APP_DB,
		env: input.env,
		userId: input.userId,
		email: input.userEmail,
		requested: estimateEntitlementStorageEntryByteDelta({
			next: {
				key: name,
				value: {
					description,
					encryptedValue,
					allowedHosts: existingEntry?.allowed_hosts ?? '[]',
					allowedCapabilities: existingEntry?.allowed_capabilities ?? '[]',
					allowedPackages: existingEntry?.allowed_packages ?? '[]',
				},
			},
			existing: existingEntry
				? {
						key: existingEntry.name,
						value: {
							description: existingEntry.description,
							encryptedValue: existingEntry.encrypted_value,
							allowedHosts: existingEntry.allowed_hosts,
							allowedCapabilities: existingEntry.allowed_capabilities,
							allowedPackages: existingEntry.allowed_packages,
						},
					}
				: null,
		}),
		waitUntil: input.waitUntil,
	})
	const now = new Date().toISOString()
	await upsertSecretEntry({
		db: input.env.APP_DB,
		row: {
			bucket_id: bucket.id,
			name,
			description,
			encrypted_value: encryptedValue,
			allowed_hosts: existingEntry?.allowed_hosts ?? '[]',
			allowed_capabilities: existingEntry?.allowed_capabilities ?? '[]',
			allowed_packages: existingEntry?.allowed_packages ?? '[]',
			created_at: existingEntry?.created_at ?? now,
			updated_at: now,
		},
	})
	return toSecretMetadata({
		name,
		scope: input.scope,
		description,
		packageId: input.scope === 'package' ? bucket.binding_key : null,
		allowedHosts: existingEntry
			? parseAllowedHosts(existingEntry.allowed_hosts)
			: [],
		allowedCapabilities: existingEntry
			? parseAllowedCapabilities(existingEntry.allowed_capabilities)
			: [],
		allowedPackages: existingEntry
			? parseAllowedPackages(existingEntry.allowed_packages)
			: [],
		createdAt: existingEntry?.created_at ?? now,
		updatedAt: now,
		expiresAt: bucket.expires_at,
	})
}

export async function updateUserSecretForPackage(input: {
	env: SecretWriteEnv
	userId: string
	userEmail?: string | null
	packageId: string
	name: string
	value: string
	description?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const [saved] = await updateUserSecretsForPackageAtomically({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		packageId: input.packageId,
		secrets: [
			{
				name: input.name,
				value: input.value,
				description: input.description,
			},
		],
		waitUntil: input.waitUntil,
	})
	if (!saved) {
		throw new Error(
			`User secret "${input.name.trim()}" no longer exists or is not approved for package "${input.packageId.trim()}".`,
		)
	}
	return saved
}

/**
 * Persist multiple secrets in one D1 batch. Callers that rotate OAuth refresh
 * tokens must pass the refresh-token entry before the access-token entry.
 * Package contexts must call `assertCanSetSecrets` before any provider request
 * that consumes a rotating refresh token; the package write path also
 * fail-closes in SQL if any secret lacks the grant.
 */
export async function setSecretsAtomically(input: {
	env: SecretWriteEnv
	userId: string
	userEmail?: string | null
	secrets: Array<{
		name: string
		value: string
		scope: SecretScope
		description?: string | null
	}>
	storageContext?: StorageContext | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<Array<SecretMetadata>> {
	if (input.secrets.length === 0) {
		throw new Error('At least one secret is required.')
	}

	const storageContext = input.storageContext ?? null
	const packageId = storageContext?.packageId?.trim() ?? ''
	const scopes = new Set(input.secrets.map((secret) => secret.scope))
	if (scopes.size !== 1) {
		throw new Error('Atomic secret writes must share a single scope.')
	}
	const scope = input.secrets[0]?.scope
	if (!scope) {
		throw new Error('At least one secret is required.')
	}

	if (scope === 'user' && packageId) {
		for (const secret of input.secrets) {
			const name = secret.name.trim()
			if (!name) throw new Error('Secret name is required.')
			const existing = await resolveSecret({
				env: input.env,
				userId: input.userId,
				name,
				scope: 'user',
				storageContext,
			})
			if (!existing.found) {
				throw new McpCallerError(
					'Package runtimes cannot create user-scoped secrets. Create the secret from the account page and approve the package first.',
				)
			}
		}
		return updateUserSecretsForPackageAtomically({
			env: input.env,
			userId: input.userId,
			userEmail: input.userEmail,
			packageId,
			secrets: input.secrets.map((secret) => ({
				name: secret.name,
				value: secret.value,
				description: secret.description,
			})),
			waitUntil: input.waitUntil,
		})
	}

	return saveSecretsAtomically({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		scope,
		secrets: input.secrets.map((secret) => ({
			name: secret.name,
			value: secret.value,
			description: secret.description,
		})),
		storageContext,
		waitUntil: input.waitUntil,
	})
}

export async function updateUserSecretsForPackageAtomically(input: {
	env: SecretWriteEnv
	userId: string
	userEmail?: string | null
	packageId: string
	secrets: Array<{
		name: string
		value: string
		description?: string | null
	}>
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<Array<SecretMetadata>> {
	const packageId = input.packageId.trim()
	if (!packageId) throw new Error('Package id is required.')
	if (input.secrets.length === 0) {
		throw new Error('At least one secret is required.')
	}

	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: 'user',
		storageContext: null,
	})
	if (!bucket) throw new Error('User secret not found.')

	const now = new Date().toISOString()
	const prepared: Array<{
		name: string
		description: string
		encryptedValue: string
		existingEntry: NonNullable<Awaited<ReturnType<typeof getSecretEntry>>>
	}> = []
	let requestedStorageBytes = 0

	for (const secret of input.secrets) {
		const name = secret.name.trim()
		if (!name) throw new Error('Secret name is required.')
		assertSecretNameAllowed(name)
		const value = secret.value.trim()
		if (!value) throw new Error('Secret value is required.')
		const existingEntry = await getSecretEntry({
			db: input.env.APP_DB,
			bucketId: bucket.id,
			name,
		})
		if (!existingEntry) throw new Error('User secret not found.')
		const description = secret.description?.trim() ?? existingEntry.description
		const encryptedValue = await encryptSecretValue(input.env, value)
		requestedStorageBytes += estimateEntitlementStorageEntryByteDelta({
			next: {
				key: name,
				value: {
					description,
					encryptedValue,
					allowedHosts: existingEntry.allowed_hosts,
					allowedCapabilities: existingEntry.allowed_capabilities,
					allowedPackages: existingEntry.allowed_packages,
				},
			},
			existing: {
				key: existingEntry.name,
				value: {
					description: existingEntry.description,
					encryptedValue: existingEntry.encrypted_value,
					allowedHosts: existingEntry.allowed_hosts,
					allowedCapabilities: existingEntry.allowed_capabilities,
					allowedPackages: existingEntry.allowed_packages,
				},
			},
		})
		prepared.push({ name, description, encryptedValue, existingEntry })
	}

	await assertWithinStorageBytesEntitlement({
		db: input.env.APP_DB,
		env: input.env,
		userId: input.userId,
		email: input.userEmail,
		requested: requestedStorageBytes,
		waitUntil: input.waitUntil,
	})

	try {
		await updateApprovedUserSecretEntriesForPackageAtomically({
			db: input.env.APP_DB,
			userId: input.userId,
			packageId,
			updates: prepared.map((entry) => ({
				name: entry.name,
				description: entry.description,
				encryptedValue: entry.encryptedValue,
				updatedAt: now,
			})),
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (message.includes('package cannot mutate one or more secrets')) {
			const names = prepared.map((entry) => entry.name).join(', ')
			throw new Error(
				`User secret(s) "${names}" no longer exist or are not approved for package "${packageId}".`,
			)
		}
		throw error
	}

	return prepared.map((entry) =>
		toSecretMetadata({
			name: entry.name,
			scope: 'user',
			description: entry.description,
			packageId: null,
			allowedHosts: parseAllowedHosts(entry.existingEntry.allowed_hosts),
			allowedCapabilities: parseAllowedCapabilities(
				entry.existingEntry.allowed_capabilities,
			),
			allowedPackages: parseAllowedPackages(
				entry.existingEntry.allowed_packages,
			),
			createdAt: entry.existingEntry.created_at,
			updatedAt: now,
			expiresAt: bucket.expires_at,
		}),
	)
}

async function saveSecretsAtomically(input: {
	env: SecretWriteEnv
	userId: string
	userEmail?: string | null
	scope: SecretScope
	secrets: Array<{
		name: string
		value: string
		description?: string | null
	}>
	storageContext?: StorageContext | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<Array<SecretMetadata>> {
	const bucket = await getOrCreateSecretBucket({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
		sessionExpiresAt: null,
	})
	const now = new Date().toISOString()
	const prepared: Array<{
		name: string
		description: string
		encryptedValue: string
		existingEntry: Awaited<ReturnType<typeof getSecretEntry>>
	}> = []
	let newSecretCount = 0
	let requestedStorageBytes = 0

	for (const secret of input.secrets) {
		const name = secret.name.trim()
		if (!name) throw new Error('Secret name is required.')
		assertSecretNameAllowed(name)
		const value = secret.value.trim()
		if (!value) throw new Error('Secret value is required.')
		const description = secret.description?.trim() ?? ''
		const existingEntry = await getSecretEntry({
			db: input.env.APP_DB,
			bucketId: bucket.id,
			name,
		})
		if (existingEntry == null) {
			newSecretCount += 1
		}
		const encryptedValue = await encryptSecretValue(input.env, value)
		requestedStorageBytes += estimateEntitlementStorageEntryByteDelta({
			next: {
				key: name,
				value: {
					description,
					encryptedValue,
					allowedHosts: existingEntry?.allowed_hosts ?? '[]',
					allowedCapabilities: existingEntry?.allowed_capabilities ?? '[]',
					allowedPackages: existingEntry?.allowed_packages ?? '[]',
				},
			},
			existing: existingEntry
				? {
						key: existingEntry.name,
						value: {
							description: existingEntry.description,
							encryptedValue: existingEntry.encrypted_value,
							allowedHosts: existingEntry.allowed_hosts,
							allowedCapabilities: existingEntry.allowed_capabilities,
							allowedPackages: existingEntry.allowed_packages,
						},
					}
				: null,
		})
		prepared.push({ name, description, encryptedValue, existingEntry })
	}

	if (newSecretCount > 0) {
		await assertWithinEntitlement({
			db: input.env.APP_DB,
			userId: input.userId,
			email: input.userEmail,
			resource: 'secrets',
			requested: newSecretCount,
		})
	}
	await assertWithinStorageBytesEntitlement({
		db: input.env.APP_DB,
		env: input.env,
		userId: input.userId,
		email: input.userEmail,
		requested: requestedStorageBytes,
		waitUntil: input.waitUntil,
	})

	await upsertSecretEntriesAtomically({
		db: input.env.APP_DB,
		rows: prepared.map((entry) => ({
			bucket_id: bucket.id,
			name: entry.name,
			description: entry.description,
			encrypted_value: entry.encryptedValue,
			allowed_hosts: entry.existingEntry?.allowed_hosts ?? '[]',
			allowed_capabilities: entry.existingEntry?.allowed_capabilities ?? '[]',
			allowed_packages: entry.existingEntry?.allowed_packages ?? '[]',
			created_at: entry.existingEntry?.created_at ?? now,
			updated_at: now,
		})),
	})

	return prepared.map((entry) =>
		toSecretMetadata({
			name: entry.name,
			scope: input.scope,
			description: entry.description,
			packageId: input.scope === 'package' ? bucket.binding_key : null,
			allowedHosts: entry.existingEntry
				? parseAllowedHosts(entry.existingEntry.allowed_hosts)
				: [],
			allowedCapabilities: entry.existingEntry
				? parseAllowedCapabilities(entry.existingEntry.allowed_capabilities)
				: [],
			allowedPackages: entry.existingEntry
				? parseAllowedPackages(entry.existingEntry.allowed_packages)
				: [],
			createdAt: entry.existingEntry?.created_at ?? now,
			updatedAt: now,
			expiresAt: bucket.expires_at,
		}),
	)
}

export async function listSecrets(
	input: ListSecretsInput,
): Promise<Array<SecretMetadata>> {
	const buckets = await getAccessibleBuckets({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope ?? null,
		storageContext: input.storageContext ?? null,
	})
	const results = await Promise.all(
		buckets.map((bucket) =>
			listSecretMetadataForBucket({
				db: input.env.APP_DB,
				bucket,
			}),
		),
	)
	return results
		.flat()
		.filter((row) => !isReservedSecretName(row.name))
		.map((row) =>
			toSecretMetadata({
				name: row.name,
				scope: row.scope,
				description: row.description,
				packageId: row.scope === 'package' ? row.binding_key : null,
				allowedHosts: parseAllowedHosts(row.allowed_hosts),
				allowedCapabilities: parseAllowedCapabilities(row.allowed_capabilities),
				allowedPackages: parseAllowedPackages(row.allowed_packages),
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				expiresAt: row.expires_at,
			}),
		)
}

export async function resolveSecret(
	input: ResolveSecretInput,
): Promise<ResolvedSecret> {
	assertSecretNameAllowed(input.name)
	const scopes = input.scope
		? [input.scope]
		: resolveSecretScopeOrder(input.storageContext ?? null)
	const scopeResults = await Promise.allSettled(
		scopes.map(async (scope) => {
			const bucket = await getExistingBucketForScope({
				db: input.env.APP_DB,
				userId: input.userId,
				scope,
				storageContext: input.storageContext ?? null,
			})
			if (!bucket) return null
			const entry = await getSecretEntry({
				db: input.env.APP_DB,
				bucketId: bucket.id,
				name: input.name,
			})
			if (!entry) return null
			const decrypted = await decryptSecretValue(
				input.env,
				entry.encrypted_value,
			)
			return {
				found: true as const,
				value: decrypted,
				scope,
				allowedHosts: parseAllowedHosts(entry.allowed_hosts),
				allowedCapabilities: parseAllowedCapabilities(
					entry.allowed_capabilities,
				),
				allowedPackages: parseAllowedPackages(entry.allowed_packages),
			}
		}),
	)
	// Preserve sequential precedence semantics: a lower-precedence failure must
	// not mask a higher-precedence hit, and a failure at the winning scope still
	// surfaces as an error.
	for (const result of scopeResults) {
		if (result.status === 'rejected') throw result.reason
		if (result.value) return result.value
	}
	return {
		found: false,
		value: null,
		scope: null,
		allowedHosts: [],
		allowedCapabilities: [],
		allowedPackages: [],
	}
}

export async function deleteSecret(input: DeleteSecretInput) {
	assertSecretNameAllowed(input.name)
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	if (!bucket) return false
	return deleteSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name: input.name,
	})
}

export async function updateSecret(
	input: UpdateSecretInput,
): Promise<SecretMetadata> {
	const name = input.name.trim()
	if (!name) {
		throw new Error('Secret name is required.')
	}
	assertSecretNameAllowed(name)
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	if (!bucket) {
		throw new Error('Secret not found for this scope.')
	}
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name,
	})
	if (!existingEntry) {
		throw new Error('Secret not found for this scope.')
	}
	const nextDescription =
		input.description == null
			? existingEntry.description
			: input.description.trim()
	const hasValueUpdate = input.value != null
	const nextValue = input.value?.trim() ?? null
	if (!hasValueUpdate && input.description == null) {
		throw new Error('Provide a new secret value or description to update.')
	}
	if (hasValueUpdate && !nextValue) {
		throw new Error('Secret value must not be empty.')
	}
	const now = new Date().toISOString()
	await upsertSecretEntry({
		db: input.env.APP_DB,
		row: {
			bucket_id: bucket.id,
			name,
			description: nextDescription,
			encrypted_value: hasValueUpdate
				? await encryptSecretValue(input.env, nextValue!)
				: existingEntry.encrypted_value,
			allowed_hosts: existingEntry.allowed_hosts,
			allowed_capabilities: existingEntry.allowed_capabilities,
			allowed_packages: existingEntry.allowed_packages,
			created_at: existingEntry.created_at,
			updated_at: now,
		},
	})
	return toSecretMetadata({
		name,
		scope: input.scope,
		description: nextDescription,
		packageId: input.scope === 'package' ? bucket.binding_key : null,
		allowedHosts: parseAllowedHosts(existingEntry.allowed_hosts),
		allowedCapabilities: parseAllowedCapabilities(
			existingEntry.allowed_capabilities,
		),
		allowedPackages: parseAllowedPackages(existingEntry.allowed_packages),
		createdAt: existingEntry.created_at,
		updatedAt: now,
		expiresAt: bucket.expires_at,
	})
}

export async function listUserSecretsForSearch(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	const rows = await listUserScopeSecretMetadata({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return rows
		.filter((row) => !isReservedSecretName(row.name))
		.map((row) => ({
			name: row.name,
			scope: row.scope,
			description: row.description,
			packageId: null,
			updatedAt: row.updated_at,
		}))
}

export async function listPackageSecretsByPackageIds(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	packageIds: Array<string>
}) {
	const rows = await listPackageScopeSecretMetadata({
		db: input.env.APP_DB,
		userId: input.userId,
		packageIds: input.packageIds,
	})
	const grouped = new Map<string, Array<SecretMetadata>>()
	for (const row of rows) {
		if (isReservedSecretName(row.name)) continue
		const packageId = row.binding_key
		const current = grouped.get(packageId) ?? []
		current.push(
			toSecretMetadata({
				name: row.name,
				scope: row.scope,
				description: row.description,
				packageId,
				allowedHosts: parseAllowedHosts(row.allowed_hosts),
				allowedCapabilities: parseAllowedCapabilities(row.allowed_capabilities),
				allowedPackages: parseAllowedPackages(row.allowed_packages),
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				expiresAt: row.expires_at,
			}),
		)
		grouped.set(packageId, current)
	}
	return grouped
}

async function getAccessibleBuckets(input: {
	db: D1Database
	userId: string
	scope: SecretScope | null
	storageContext: StorageContext | null
}) {
	const scopes = input.scope
		? [input.scope]
		: resolveSecretScopeOrder(input.storageContext)
	const buckets = await Promise.all(
		scopes.map((scope) =>
			getExistingBucketForScope({
				db: input.db,
				userId: input.userId,
				scope,
				storageContext: input.storageContext,
			}),
		),
	)
	return buckets.filter(
		(bucket): bucket is NonNullable<typeof bucket> => bucket != null,
	)
}

async function getExistingBucketForScope(input: {
	db: D1Database
	userId: string
	scope: SecretScope
	storageContext: StorageContext | null
}) {
	const bindingKey = getSecretBindingKey(input.scope, input.storageContext)
	if (bindingKey == null) return null
	return getSecretBucket({
		db: input.db,
		userId: input.userId,
		scope: input.scope,
		bindingKey,
	})
}

async function getOrCreateSecretBucket(input: {
	db: D1Database
	userId: string
	scope: SecretScope
	storageContext: StorageContext | null
	sessionExpiresAt: string | null
}) {
	const bindingKey = getSecretBindingKey(input.scope, input.storageContext)
	if (bindingKey == null) {
		// Caller asked for session/package scope without that binding in the
		// current storage context. Keep it off Sentry via McpCallerError.
		throw new McpCallerError(
			`Secret scope "${input.scope}" is unavailable in this context.`,
		)
	}
	const existing = await getSecretBucket({
		db: input.db,
		userId: input.userId,
		scope: input.scope,
		bindingKey,
	})
	if (existing) {
		const nextExpiresAt =
			input.scope === 'session'
				? (input.sessionExpiresAt ?? existing.expires_at)
				: null
		if (existing.expires_at !== nextExpiresAt) {
			await upsertSecretBucket({
				db: input.db,
				row: {
					...existing,
					expires_at: nextExpiresAt,
				},
			})
			return {
				...existing,
				expires_at: nextExpiresAt,
				updated_at: new Date().toISOString(),
			}
		}
		return existing
	}
	const now = new Date().toISOString()
	const created = {
		id: crypto.randomUUID(),
		user_id: input.userId,
		scope: input.scope,
		binding_key: bindingKey,
		expires_at:
			input.scope === 'session' ? (input.sessionExpiresAt ?? null) : null,
		created_at: now,
		updated_at: now,
	}
	await upsertSecretBucket({
		db: input.db,
		row: created,
	})
	return created
}

function toSecretMetadata(input: {
	name: string
	scope: SecretScope
	description: string
	packageId: string | null
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	allowedPackages: Array<string>
	createdAt: string
	updatedAt: string
	expiresAt: string | null
}): SecretMetadata {
	return {
		name: input.name,
		scope: input.scope,
		description: input.description,
		packageId: input.packageId,
		allowedHosts: normalizeAllowedHosts(input.allowedHosts),
		allowedCapabilities: normalizeAllowedCapabilities(
			input.allowedCapabilities,
		),
		allowedPackages: normalizeAllowedPackages(input.allowedPackages),
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		ttlMs:
			input.expiresAt == null
				? null
				: Math.max(0, new Date(input.expiresAt).getTime() - Date.now()),
	}
}

export async function setSecretAllowedHosts(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	scope: SecretScope
	allowedHosts: Array<string>
	storageContext?: StorageContext | null
}) {
	const name = input.name.trim()
	if (!name) {
		throw new Error('Secret name is required.')
	}
	assertSecretNameAllowed(name)
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	if (!bucket) {
		throw new Error('Secret not found for this scope.')
	}
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name,
	})
	if (!existingEntry) {
		throw new Error('Secret not found for this scope.')
	}
	const now = new Date().toISOString()
	await upsertSecretEntry({
		db: input.env.APP_DB,
		row: {
			...existingEntry,
			allowed_hosts: stringifyAllowedHosts(input.allowedHosts),
			updated_at: now,
		},
	})
	return toSecretMetadata({
		name,
		scope: input.scope,
		description: existingEntry.description,
		packageId: input.scope === 'package' ? bucket.binding_key : null,
		allowedHosts: input.allowedHosts,
		allowedCapabilities: parseAllowedCapabilities(
			existingEntry.allowed_capabilities,
		),
		allowedPackages: parseAllowedPackages(existingEntry.allowed_packages),
		createdAt: existingEntry.created_at,
		updatedAt: now,
		expiresAt: bucket.expires_at,
	})
}

export async function setSecretAllowedCapabilities(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	scope: SecretScope
	allowedCapabilities: Array<string>
	storageContext?: StorageContext | null
}) {
	const name = input.name.trim()
	if (!name) {
		throw new Error('Secret name is required.')
	}
	assertSecretNameAllowed(name)
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	if (!bucket) {
		throw new Error('Secret not found for this scope.')
	}
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name,
	})
	if (!existingEntry) {
		throw new Error('Secret not found for this scope.')
	}
	const now = new Date().toISOString()
	await upsertSecretEntry({
		db: input.env.APP_DB,
		row: {
			...existingEntry,
			allowed_capabilities: stringifyAllowedCapabilities(
				input.allowedCapabilities,
			),
			updated_at: now,
		},
	})
	return toSecretMetadata({
		name,
		scope: input.scope,
		description: existingEntry.description,
		packageId: input.scope === 'package' ? bucket.binding_key : null,
		allowedHosts: parseAllowedHosts(existingEntry.allowed_hosts),
		allowedCapabilities: input.allowedCapabilities,
		allowedPackages: parseAllowedPackages(existingEntry.allowed_packages),
		createdAt: existingEntry.created_at,
		updatedAt: now,
		expiresAt: bucket.expires_at,
	})
}

export async function setSecretAllowedPackages(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	scope: SecretScope
	allowedPackages: Array<string>
	storageContext?: StorageContext | null
}) {
	if (input.scope !== 'user' && input.allowedPackages.length > 0) {
		throw new Error('Package approvals are only supported for user secrets.')
	}
	const name = input.name.trim()
	if (!name) {
		throw new Error('Secret name is required.')
	}
	assertSecretNameAllowed(name)
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	if (!bucket) {
		throw new Error('Secret not found for this scope.')
	}
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name,
	})
	if (!existingEntry) {
		throw new Error('Secret not found for this scope.')
	}
	const now = new Date().toISOString()
	await upsertSecretEntry({
		db: input.env.APP_DB,
		row: {
			...existingEntry,
			allowed_packages: stringifyAllowedPackages(input.allowedPackages),
			updated_at: now,
		},
	})
	return toSecretMetadata({
		name,
		scope: input.scope,
		description: existingEntry.description,
		packageId: input.scope === 'package' ? bucket.binding_key : null,
		allowedHosts: parseAllowedHosts(existingEntry.allowed_hosts),
		allowedCapabilities: parseAllowedCapabilities(
			existingEntry.allowed_capabilities,
		),
		allowedPackages: input.allowedPackages,
		createdAt: existingEntry.created_at,
		updatedAt: now,
		expiresAt: bucket.expires_at,
	})
}

export async function resolveSecretForHost(
	input: ResolveSecretInput & {
		host: string
	},
) {
	const normalizedHost = normalizeHost(input.host)
	const resolved = await resolveSecret(input)
	if (!resolved.found) return resolved
	return {
		...resolved,
		allowedForHost: resolved.allowedHosts.includes(normalizedHost),
	}
}
