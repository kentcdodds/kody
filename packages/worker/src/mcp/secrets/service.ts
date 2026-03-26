import { decryptSecretValue, encryptSecretValue } from './crypto.ts'
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
import {
	type SecretContext,
	type SecretMetadata,
	type SecretScope,
} from './types.ts'

type SecretOwnerContext = {
	userId: string
	secretContext?: SecretContext | null
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

const defaultLookupOrder: Array<SecretScope> = ['session', 'app', 'user']

export type ResolvedSecret = {
	found: boolean
	value: string | null
	scope: SecretScope | null
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
		secretContext: input.secretContext ?? null,
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
			created_at: existingEntry?.created_at ?? now,
			updated_at: now,
		},
	})
	return toSecretMetadata({
		name,
		scope: input.scope,
		description,
		appId: input.scope === 'app' ? bucket.binding_key : null,
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
		secretContext: input.secretContext ?? null,
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
		: resolveScopeOrder(input.secretContext ?? null)
	for (const scope of scopes) {
		const bucket = await getExistingBucketForScope({
			db: input.env.APP_DB,
			userId: input.userId,
			scope,
			secretContext: input.secretContext ?? null,
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
		}
	}
	return {
		found: false,
		value: null,
		scope: null,
	}
}

export async function deleteSecret(input: DeleteSecretInput) {
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		secretContext: input.secretContext ?? null,
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
		secretContext: input.secretContext ?? null,
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
			created_at: existingEntry.created_at,
			updated_at: now,
		},
	})
	return toSecretMetadata({
		name,
		scope: input.scope,
		description: nextDescription,
		appId: input.scope === 'app' ? bucket.binding_key : null,
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
	secretContext: SecretContext | null
}) {
	const scopes = input.scope
		? [input.scope]
		: resolveScopeOrder(input.secretContext)
	const buckets = await Promise.all(
		scopes.map((scope) =>
			getExistingBucketForScope({
				db: input.db,
				userId: input.userId,
				scope,
				secretContext: input.secretContext,
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
	secretContext: SecretContext | null
}) {
	const bindingKey = getBindingKey(input.scope, input.secretContext)
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
	secretContext: SecretContext | null
	sessionExpiresAt: string | null
}) {
	const bindingKey = getBindingKey(input.scope, input.secretContext)
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

function resolveScopeOrder(secretContext: SecretContext | null) {
	return defaultLookupOrder.filter(
		(scope) => getBindingKey(scope, secretContext) != null,
	)
}

function getBindingKey(
	scope: SecretScope,
	secretContext: SecretContext | null,
) {
	if (scope === 'user') return ''
	if (scope === 'app') {
		return secretContext?.appId?.trim() ? secretContext.appId : null
	}
	if (scope === 'session') {
		return secretContext?.sessionId?.trim() ? secretContext.sessionId : null
	}
	return null
}

function toSecretMetadata(input: {
	name: string
	scope: SecretScope
	description: string
	appId: string | null
	createdAt: string
	updatedAt: string
	expiresAt: string | null
}): SecretMetadata {
	return {
		name: input.name,
		scope: input.scope,
		description: input.description,
		appId: input.appId,
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		ttlMs:
			input.expiresAt == null
				? null
				: Math.max(0, new Date(input.expiresAt).getTime() - Date.now()),
	}
}
