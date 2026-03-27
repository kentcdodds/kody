import { storageScopeValues, type StorageScope } from '#mcp/storage.ts'

export const valueScopeValues = storageScopeValues

export type ValueScope = StorageScope

export type ValueBucketRow = {
	id: string
	user_id: string
	scope: ValueScope
	binding_key: string
	expires_at: string | null
	created_at: string
	updated_at: string
}

export type ValueEntryRow = {
	bucket_id: string
	name: string
	description: string
	value: string
	created_at: string
	updated_at: string
}

export type ValueMetadata = {
	name: string
	scope: ValueScope
	value: string
	description: string
	appId: string | null
	createdAt: string
	updatedAt: string
	ttlMs: number | null
}
