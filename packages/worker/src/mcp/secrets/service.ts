import {
	normalizeAllowedCapabilities,
	parseAllowedCapabilities,
	stringifyAllowedCapabilities,
} from './allowed-capabilities.ts'
import {
	normalizeAllowedHosts,
	normalizeHost,
	parseAllowedHosts,
	stringifyAllowedHosts,
} from './allowed-hosts.ts'
import { decryptSecretValue, encryptSecretValue } from './crypto.ts'
import {
	getStorageBindingKey,
	resolveStorageScopeOrder,
} from '#mcp/storage-bindings.ts'
import { type StorageContext } from '#mcp/storage.ts'
import {
	deleteSecretEntry,
	getSecretBucket,
	getSecretEntry,
	listAppScopeSecretMetadata,
	listSecretMetadataForBucket,
	listUserScopeSecretMetadata,
	upsertSecretBucket,
	upsertSecretEntry,
} from './repo.ts'
import { type SecretMetadata, type SecretScope } from './types.ts'

type SecretOwnerContext = {
	userId: string
	storageContext?: StorageContext | null
}

type SaveSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
	scope: SecretScope
	name: string
	value: string
	description?: string | null
	sessionExpiresAt?: string | null
}

type ListSecretsInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	scope?: SecretScope | null
}

type ResolveSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
	name: string
	scope?: SecretScope | null
}

type UpdateSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
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
}

export async function saveSecret(
	input: SaveSecretInput,
): Promise<SecretMetadata> {
	const name = input.name.trim()
	if (!name) {
		throw new Error('Secret name is required.')
	}
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
	const now = new Date().toISOString()
	await upsertSecretEntry({
		db: input.env.APP_DB,
		row: {
			bucket_id: bucket.id,
			name,
			description,
			encrypted_value: await encryptSecretValue(input.env, value),
			allowed_hosts: existingEntry?.allowed_hosts ?? '[]',
			allowed_capabilities: existingEntry?.allowed_capabilities ?? '[]',
			created_at: existingEntry?.created_at ?? now,
			updated_at: now,
		},
	})
	return toSecretMetadata({
		name,
		scope: input.scope,
		description,
		appId: input.scope === 'app' ? bucket.binding_key : null,
		allowedHosts: existingEntry
			? parseAllowedHosts(existingEntry.allowed_hosts)
			: [],
		allowedCapabilities: existingEntry
			? parseAllowedCapabilities(existingEntry.allowed_capabilities)
			: [],
		createdAt: existingEntry?.created_at ?? now,
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
	return results.flat().map((row) =>
		toSecretMetadata({
			name: row.name,
			scope: row.scope,
			description: row.description,
			appId: row.scope === 'app' ? row.binding_key : null,
			allowedHosts: parseAllowedHosts(row.allowed_hosts),
			allowedCapabilities: parseAllowedCapabilities(row.allowed_capabilities),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			expiresAt: row.expires_at,
		}),
	)
}

export async function resolveSecret(
	input: ResolveSecretInput,
): Promise<ResolvedSecret> {
	const scopes = input.scope
		? [input.scope]
		: resolveStorageScopeOrder(input.storageContext ?? null)
	for (const scope of scopes) {
		const bucket = await getExistingBucketForScope({
			db: input.env.APP_DB,
			userId: input.userId,
			scope,
			storageContext: input.storageContext ?? null,
		})
		if (!bucket) continue
		const entry = await getSecretEntry({
			db: input.env.APP_DB,
			bucketId: bucket.id,
			name: input.name,
		})
		if (!entry) continue
		return {
			found: true,
			value: await decryptSecretValue(input.env, entry.encrypted_value),
			scope,
			allowedHosts: parseAllowedHosts(entry.allowed_hosts),
			allowedCapabilities: parseAllowedCapabilities(entry.allowed_capabilities),
		}
	}
	return {
		found: false,
		value: null,
		scope: null,
		allowedHosts: [],
		allowedCapabilities: [],
	}
}

export async function deleteSecret(input: DeleteSecretInput) {
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
			created_at: existingEntry.created_at,
			updated_at: now,
		},
	})
	return toSecretMetadata({
		name,
		scope: input.scope,
		description: nextDescription,
		appId: input.scope === 'app' ? bucket.binding_key : null,
		allowedHosts: parseAllowedHosts(existingEntry.allowed_hosts),
		allowedCapabilities: parseAllowedCapabilities(
			existingEntry.allowed_capabilities,
		),
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
	return rows.map((row) => ({
		name: row.name,
		scope: row.scope,
		description: row.description,
		appId: null,
		updatedAt: row.updated_at,
	}))
}

export async function listAppSecretsByAppIds(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	appIds: Array<string>
}) {
	const rows = await listAppScopeSecretMetadata({
		db: input.env.APP_DB,
		userId: input.userId,
		appIds: input.appIds,
	})
	const grouped = new Map<string, Array<SecretMetadata>>()
	for (const row of rows) {
		const appId = row.binding_key
		const current = grouped.get(appId) ?? []
		current.push(
			toSecretMetadata({
				name: row.name,
				scope: row.scope,
				description: row.description,
				appId,
				allowedHosts: parseAllowedHosts(row.allowed_hosts),
				allowedCapabilities: parseAllowedCapabilities(row.allowed_capabilities),
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				expiresAt: row.expires_at,
			}),
		)
		grouped.set(appId, current)
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
		: resolveStorageScopeOrder(input.storageContext)
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
	const bindingKey = getStorageBindingKey(input.scope, input.storageContext)
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
	const bindingKey = getStorageBindingKey(input.scope, input.storageContext)
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
	appId: string | null
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	createdAt: string
	updatedAt: string
	expiresAt: string | null
}): SecretMetadata {
	return {
		name: input.name,
		scope: input.scope,
		description: input.description,
		appId: input.appId,
		allowedHosts: normalizeAllowedHosts(input.allowedHosts),
		allowedCapabilities: normalizeAllowedCapabilities(
			input.allowedCapabilities,
		),
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
		appId: input.scope === 'app' ? bucket.binding_key : null,
		allowedHosts: input.allowedHosts,
		allowedCapabilities: parseAllowedCapabilities(
			existingEntry.allowed_capabilities,
		),
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
		appId: input.scope === 'app' ? bucket.binding_key : null,
		allowedHosts: parseAllowedHosts(existingEntry.allowed_hosts),
		allowedCapabilities: input.allowedCapabilities,
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
