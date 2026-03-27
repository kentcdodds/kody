export const secretScopeValues = ['session', 'app', 'user'] as const

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
	created_at: string
	updated_at: string
}

export type SecretMetadata = {
	name: string
	scope: SecretScope
	description: string
	appId: string | null
	allowedHosts: Array<string>
	createdAt: string
	updatedAt: string
	ttlMs: number | null
}

export type SecretSearchRow = Pick<
	SecretMetadata,
	'name' | 'scope' | 'description' | 'appId' | 'updatedAt'
>

export type SecretContext = {
	sessionId: string | null
	appId: string | null
}
