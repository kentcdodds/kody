import { type StorageContext } from '#mcp/storage.ts'

export const secretScopeValues = ['session', 'package', 'user'] as const

export type SecretScope = (typeof secretScopeValues)[number]

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
	packageId: string | null
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	allowedPackages: Array<string>
	createdAt: string
	updatedAt: string
	ttlMs: number | null
}

export type SecretSearchRow = Pick<
	SecretMetadata,
	'name' | 'scope' | 'description' | 'packageId' | 'updatedAt'
>

export type { StorageContext }
