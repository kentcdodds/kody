import {
	getStorageBindingKey,
	resolveStorageScopeOrder,
} from '#mcp/storage-bindings.ts'
import { type StorageContext } from '#mcp/storage.ts'
import {
	deleteValueBucketByBinding,
	deleteValueEntry,
	getValueBucket,
	getValueEntry,
	listValueMetadataForBucket,
	upsertValueBucket,
	upsertValueEntry,
} from './repo.ts'
import { type ValueMetadata, type ValueScope } from './types.ts'

type ValueOwnerContext = {
	userId: string
	storageContext?: StorageContext | null
}

type SaveValueInput = ValueOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	scope: ValueScope
	name: string
	value: string
	description?: string | null
	sessionExpiresAt?: string | null
}

type ListValuesInput = ValueOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	scope?: ValueScope | null
}

type GetValueInput = ValueOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	name: string
	scope?: ValueScope | null
}

type DeleteValueInput = ValueOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	name: string
	scope: ValueScope
}

const defaultSessionValueTtlMs = 60 * 60 * 1000

export async function saveValue(input: SaveValueInput): Promise<ValueMetadata> {
	const name = input.name.trim()
	if (!name) {
		throw new Error('Value name is required.')
	}
	const value = input.value.trim()
	if (!value) {
		throw new Error('Value is required.')
	}
	const description = input.description?.trim() ?? ''
	const bucket = await getOrCreateValueBucket({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
		sessionExpiresAt: input.sessionExpiresAt ?? null,
	})
	const existingEntry = await getValueEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name,
	})
	const now = new Date().toISOString()
	await upsertValueEntry({
		db: input.env.APP_DB,
		row: {
			bucket_id: bucket.id,
			name,
			description,
			value,
			created_at: existingEntry?.created_at ?? now,
			updated_at: now,
		},
	})
	return toValueMetadata({
		name,
		scope: input.scope,
		value,
		description,
		appId: input.scope === 'app' ? bucket.binding_key : null,
		createdAt: existingEntry?.created_at ?? now,
		updatedAt: now,
		expiresAt: bucket.expires_at,
	})
}

export async function listValues(
	input: ListValuesInput,
): Promise<Array<ValueMetadata>> {
	const buckets = await getAccessibleBuckets({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope ?? null,
		storageContext: input.storageContext ?? null,
	})
	const results = await Promise.all(
		buckets.map((bucket) =>
			listValueMetadataForBucket({
				db: input.env.APP_DB,
				bucket,
			}),
		),
	)
	return results.flat().map((row) =>
		toValueMetadata({
			name: row.name,
			scope: row.scope,
			value: row.value,
			description: row.description,
			appId: row.scope === 'app' ? row.binding_key : null,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			expiresAt: row.expires_at,
		}),
	)
}

export async function getValue(
	input: GetValueInput,
): Promise<ValueMetadata | null> {
	const name = input.name.trim()
	if (!name) {
		throw new Error('Value name is required.')
	}
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
		const entry = await getValueEntry({
			db: input.env.APP_DB,
			bucketId: bucket.id,
			name,
		})
		if (!entry) continue
		return toValueMetadata({
			name,
			scope,
			value: entry.value,
			description: entry.description,
			appId: scope === 'app' ? bucket.binding_key : null,
			createdAt: entry.created_at,
			updatedAt: entry.updated_at,
			expiresAt: bucket.expires_at,
		})
	}
	return null
}

export async function deleteValue(input: DeleteValueInput) {
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	if (!bucket) return false
	return deleteValueEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name: input.name,
	})
}

export async function deleteAllAppScopedValues(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	appId: string
}) {
	return deleteValueBucketByBinding({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: 'app',
		bindingKey: input.appId,
	})
}

async function getAccessibleBuckets(input: {
	db: D1Database
	userId: string
	scope: ValueScope | null
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
	scope: ValueScope
	storageContext: StorageContext | null
}) {
	const bindingKey = getStorageBindingKey(input.scope, input.storageContext)
	if (bindingKey == null) return null
	return getValueBucket({
		db: input.db,
		userId: input.userId,
		scope: input.scope,
		bindingKey,
	})
}

async function getOrCreateValueBucket(input: {
	db: D1Database
	userId: string
	scope: ValueScope
	storageContext: StorageContext | null
	sessionExpiresAt: string | null
}) {
	const bindingKey = getStorageBindingKey(input.scope, input.storageContext)
	if (bindingKey == null) {
		throw new Error(
			`Value scope "${input.scope}" is unavailable in this context.`,
		)
	}
	const existing = await getValueBucket({
		db: input.db,
		userId: input.userId,
		scope: input.scope,
		bindingKey,
	})
	if (existing) {
		const nextExpiresAt =
			input.scope === 'session'
				? resolveSessionValueExpiry(input.sessionExpiresAt, existing.expires_at)
				: null
		if (existing.expires_at !== nextExpiresAt) {
			await upsertValueBucket({
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
			input.scope === 'session'
				? resolveSessionValueExpiry(input.sessionExpiresAt, null)
				: null,
		created_at: now,
		updated_at: now,
	}
	await upsertValueBucket({
		db: input.db,
		row: created,
	})
	return created
}

function toValueMetadata(input: {
	name: string
	scope: ValueScope
	value: string
	description: string
	appId: string | null
	createdAt: string
	updatedAt: string
	expiresAt: string | null
}): ValueMetadata {
	return {
		name: input.name,
		scope: input.scope,
		value: input.value,
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

function resolveSessionValueExpiry(
	sessionExpiresAt: string | null,
	existingExpiresAt: string | null,
) {
	if (sessionExpiresAt) return sessionExpiresAt
	if (existingExpiresAt) return existingExpiresAt
	return new Date(Date.now() + defaultSessionValueTtlMs).toISOString()
}
