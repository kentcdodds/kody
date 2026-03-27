export type GeneratedUiStorageScope = 'session' | 'app' | 'user'

export type GeneratedUiSecretMetadata = {
	name: string
	scope: GeneratedUiStorageScope
	description: string
	app_id: string | null
	allowed_hosts: Array<string>
	created_at: string
	updated_at: string
	ttl_ms: number | null
}

export type GeneratedUiValueMetadata = {
	name: string
	scope: GeneratedUiStorageScope
	value: string
	description: string
	app_id: string | null
	created_at: string
	updated_at: string
	ttl_ms: number | null
}

export type GeneratedUiSessionEndpoints = {
	source: string
	execute: string
	secrets: string
	deleteSecret: string
}

export type GeneratedUiAppSessionBootstrap = {
	token?: string
	endpoints: GeneratedUiSessionEndpoints
}

export type GeneratedUiRuntimeBootstrap = {
	mode: 'hosted' | 'mcp' | 'shell'
	params?: Record<string, unknown>
	appSession?: GeneratedUiAppSessionBootstrap | null
}
