import {
	earliestSecretExpiresAt,
	isSecretExpired,
	nextSecretExpiresAt,
	secretTtlMs,
} from '@kody-internal/shared/secret-expires-at.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
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
import {
	decryptSecretValue,
	encryptSecretValue,
	userSecretContext,
} from './crypto.ts'
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
import { listReferencedIntegrationSecretNames } from '#worker/integrations/owned-secret-names.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'

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
	expiresAt?: string | null
	sessionExpiresAt?: string | null
	userEmail?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}

type ListSecretsInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	scope?: SecretScope | null
	includeIntegrationOwned?: boolean
}

type ResolveSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	name: string
	scope?: SecretScope | null
	includeExpired?: boolean
}

type UpdateSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	name: string
	scope: SecretScope
	value?: string | null
	description?: string | null
	expiresAt?: string | null
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
	const encryptedValue = await encryptSecretValue(
		input.env,
		value,
		userSecretContext(input.userId),
	)
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
							allowedPackages: existingEntry.allowed_packages,
						},
					}
				: null,
		}),
	})
	const now = new Date().toISOString()
	const entryExpiresAt = nextSecretExpiresAt({
		existing: existingEntry?.expires_at,
		requested: input.expiresAt,
	})
	await upsertSecretEntry({
		db: input.env.APP_DB,
		row: {
			bucket_id: bucket.id,
			name,
			description,
			encrypted_value: encryptedValue,
			allowed_hosts: existingEntry?.allowed_hosts ?? '[]',
			allowed_packages: existingEntry?.allowed_packages ?? '[]',
			expires_at: entryExpiresAt,
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
		allowedPackages: existingEntry
			? parseAllowedPackages(existingEntry.allowed_packages)
			: [],
		createdAt: existingEntry?.created_at ?? now,
		updatedAt: now,
		expiresAt: earliestSecretExpiresAt(entryExpiresAt, bucket.expires_at),
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
		expiresAt?: string | null
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
		if (input.secrets.some((secret) => secret.expiresAt !== undefined)) {
			throw new McpCallerError(
				'Package runtimes cannot change user secret expiry. Set expires_at from the account page or secretSet outside a package.',
			)
		}
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
			expiresAt: secret.expiresAt,
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
		const encryptedValue = await encryptSecretValue(
			input.env,
			value,
			userSecretContext(input.userId),
		)
		requestedStorageBytes += estimateEntitlementStorageEntryByteDelta({
			next: {
				key: name,
				value: {
					description,
					encryptedValue,
					allowedHosts: existingEntry.allowed_hosts,
					allowedPackages: existingEntry.allowed_packages,
				},
			},
			existing: {
				key: existingEntry.name,
				value: {
					description: existingEntry.description,
					encryptedValue: existingEntry.encrypted_value,
					allowedHosts: existingEntry.allowed_hosts,
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
			allowedPackages: parseAllowedPackages(
				entry.existingEntry.allowed_packages,
			),
			createdAt: entry.existingEntry.created_at,
			updatedAt: now,
			expiresAt: earliestSecretExpiresAt(
				entry.existingEntry.expires_at,
				bucket.expires_at,
			),
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
		expiresAt?: string | null
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
		expiresAt: string | null
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
		const encryptedValue = await encryptSecretValue(
			input.env,
			value,
			userSecretContext(input.userId),
		)
		requestedStorageBytes += estimateEntitlementStorageEntryByteDelta({
			next: {
				key: name,
				value: {
					description,
					encryptedValue,
					allowedHosts: existingEntry?.allowed_hosts ?? '[]',
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
							allowedPackages: existingEntry.allowed_packages,
						},
					}
				: null,
		})
		prepared.push({
			name,
			description,
			encryptedValue,
			expiresAt: nextSecretExpiresAt({
				existing: existingEntry?.expires_at,
				requested: secret.expiresAt,
			}),
			existingEntry,
		})
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
	})

	await upsertSecretEntriesAtomically({
		db: input.env.APP_DB,
		rows: prepared.map((entry) => ({
			bucket_id: bucket.id,
			name: entry.name,
			description: entry.description,
			encrypted_value: entry.encryptedValue,
			allowed_hosts: entry.existingEntry?.allowed_hosts ?? '[]',
			allowed_packages: entry.existingEntry?.allowed_packages ?? '[]',
			expires_at: entry.expiresAt,
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
			allowedPackages: entry.existingEntry
				? parseAllowedPackages(entry.existingEntry.allowed_packages)
				: [],
			createdAt: entry.existingEntry?.created_at ?? now,
			updatedAt: now,
			expiresAt: earliestSecretExpiresAt(entry.expiresAt, bucket.expires_at),
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
	const listed = results
		.flat()
		.filter((row) => !isReservedSecretName(row.name))
		.map((row) =>
			toSecretMetadata({
				name: row.name,
				scope: row.scope,
				description: row.description,
				packageId: row.scope === 'package' ? row.binding_key : null,
				allowedHosts: parseAllowedHosts(row.allowed_hosts),
				allowedPackages: parseAllowedPackages(row.allowed_packages),
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				expiresAt: row.expires_at,
			}),
		)
	if (input.includeIntegrationOwned) return listed
	const ownedNames = await listReferencedIntegrationSecretNames({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return listed.filter(
		(row) => row.scope !== 'user' || !ownedNames.has(row.name),
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
			if (!input.includeExpired && isSecretExpired(entry.expires_at)) {
				return null
			}
			const decrypted = await decryptSecretValue(
				input.env,
				entry.encrypted_value,
				userSecretContext(input.userId),
			)
			return {
				found: true as const,
				value: decrypted,
				scope,
				allowedHosts: parseAllowedHosts(entry.allowed_hosts),
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
	if (
		!hasValueUpdate &&
		input.description == null &&
		input.expiresAt === undefined
	) {
		throw new Error(
			'Provide a new secret value, description, or expires_at to update.',
		)
	}
	if (hasValueUpdate && !nextValue) {
		throw new Error('Secret value must not be empty.')
	}
	const now = new Date().toISOString()
	const entryExpiresAt = nextSecretExpiresAt({
		existing: existingEntry.expires_at,
		requested: input.expiresAt,
	})
	await upsertSecretEntry({
		db: input.env.APP_DB,
		row: {
			bucket_id: bucket.id,
			name,
			description: nextDescription,
			encrypted_value: hasValueUpdate
				? await encryptSecretValue(
						input.env,
						nextValue!,
						userSecretContext(input.userId),
					)
				: existingEntry.encrypted_value,
			allowed_hosts: existingEntry.allowed_hosts,
			allowed_packages: existingEntry.allowed_packages,
			expires_at: entryExpiresAt,
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
		allowedPackages: parseAllowedPackages(existingEntry.allowed_packages),
		createdAt: existingEntry.created_at,
		updatedAt: now,
		expiresAt: earliestSecretExpiresAt(entryExpiresAt, bucket.expires_at),
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
	const ownedNames = await listReferencedIntegrationSecretNames({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return rows
		.filter(
			(row) => !isReservedSecretName(row.name) && !ownedNames.has(row.name),
		)
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
		allowedPackages: normalizeAllowedPackages(input.allowedPackages),
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		expiresAt: input.expiresAt,
		ttlMs: secretTtlMs(input.expiresAt),
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
		allowedPackages: parseAllowedPackages(existingEntry.allowed_packages),
		createdAt: existingEntry.created_at,
		updatedAt: now,
		expiresAt: earliestSecretExpiresAt(
			existingEntry.expires_at,
			bucket.expires_at,
		),
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
		allowedPackages: input.allowedPackages,
		createdAt: existingEntry.created_at,
		updatedAt: now,
		expiresAt: earliestSecretExpiresAt(
			existingEntry.expires_at,
			bucket.expires_at,
		),
	})
}

/**
 * Tighten-only package grant on a user secret. Adds `packageId` to
 * `allowed_packages`. Additional grants accumulate. Removing a grant is
 * website-only. User-scope only — package secrets do not have this grant.
 */
export async function lockSecretToPackage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	packageId: string
}): Promise<SecretMetadata> {
	const packageId = input.packageId.trim()
	if (!packageId) {
		throw new Error('Package id is required.')
	}
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId,
	})
	if (!savedPackage) {
		throw new Error('Saved package not found for this user.')
	}
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: 'user',
		storageContext: null,
	})
	if (!bucket) {
		throw new Error('Secret not found for this scope.')
	}
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name: input.name.trim(),
	})
	if (!existingEntry) {
		throw new Error('Secret not found for this scope.')
	}
	const currentPackages = parseAllowedPackages(existingEntry.allowed_packages)
	if (currentPackages.includes(packageId)) {
		return toSecretMetadata({
			name: input.name.trim(),
			scope: 'user',
			description: existingEntry.description,
			packageId: null,
			allowedHosts: parseAllowedHosts(existingEntry.allowed_hosts),
			allowedPackages: currentPackages,
			createdAt: existingEntry.created_at,
			updatedAt: existingEntry.updated_at,
			expiresAt: earliestSecretExpiresAt(
				existingEntry.expires_at,
				bucket.expires_at,
			),
		})
	}
	return setSecretAllowedPackages({
		env: input.env,
		userId: input.userId,
		name: input.name,
		scope: 'user',
		allowedPackages: [...currentPackages, packageId],
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
