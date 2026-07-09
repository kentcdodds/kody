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
	deletePackageScopeSecretBuckets,
	deleteSecretEntry,
	getSecretBucket,
	getSecretEntry,
	listPackageScopeSecretMetadata,
	listSecretMetadataForBucket,
	listUserScopeSecretMetadata,
	removePackageFromSecretApprovals,
	updateApprovedUserSecretEntryForPackage,
	upsertSecretBucket,
	upsertSecretEntry,
} from './repo.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	estimateEntitlementStorageEntryByteDelta,
} from '#worker/entitlements/service.ts'
import { type SecretMetadata, type SecretScope } from './types.ts'

type SecretOwnerContext = {
	userId: string
	storageContext?: StorageContext | null
}

type SaveSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	scope: SecretScope
	name: string
	value: string
	description?: string | null
	sessionExpiresAt?: string | null
	userEmail?: string | null
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
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	userId: string
	userEmail?: string | null
	packageId: string
	name: string
	value: string
	description?: string | null
}) {
	const name = input.name.trim()
	if (!name) throw new Error('Secret name is required.')
	assertSecretNameAllowed(name)
	const value = input.value.trim()
	if (!value) throw new Error('Secret value is required.')
	const packageId = input.packageId.trim()
	if (!packageId) throw new Error('Package id is required.')

	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: 'user',
		storageContext: null,
	})
	if (!bucket) throw new Error('User secret not found.')
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name,
	})
	if (!existingEntry) throw new Error('User secret not found.')

	const description = input.description?.trim() ?? existingEntry.description
	const encryptedValue = await encryptSecretValue(input.env, value)
	await assertWithinStorageBytesEntitlement({
		db: input.env.APP_DB,
		userId: input.userId,
		email: input.userEmail,
		requested: estimateEntitlementStorageEntryByteDelta({
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
		}),
	})
	const now = new Date().toISOString()
	const updated = await updateApprovedUserSecretEntryForPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId,
		name,
		description,
		encryptedValue,
		updatedAt: now,
	})
	if (!updated) {
		throw new Error(
			`User secret "${name}" no longer exists or is not approved for package "${packageId}".`,
		)
	}
	return toSecretMetadata({
		name,
		scope: 'user',
		description,
		packageId: null,
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

export async function deleteAllPackageScopedSecrets(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	packageId: string
}) {
	return await deletePackageScopeSecretBuckets({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
	})
}

export async function removeAllSecretApprovalsForPackage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	packageId: string
}) {
	return await removePackageFromSecretApprovals({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
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
		throw new Error(
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
