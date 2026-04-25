import {
	storageScopeValues,
	type StorageContext,
	type StorageScope,
} from '#mcp/storage.ts'

export const secretScopeValues = storageScopeValues

export type SecretScope = StorageScope

export type SecretBucketRow = {
	id: string
	user_id: string
	scope: SecretScope
	binding_key: string
	expires_at: string | null
	created_at: string
	updated_at: string
}

export type SecretEntryRow = {
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

export type SecretMetadata = {
	name: string
	scope: SecretScope
	description: string
	appId: string | null
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	allowedPackages: Array<string>
	createdAt: string
	updatedAt: string
	ttlMs: number | null
}

export type SecretSearchRow = Pick<
	SecretMetadata,
	'name' | 'scope' | 'description' | 'appId' | 'updatedAt'
>

export type { StorageContext }
