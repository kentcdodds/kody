export type ProviderConnectionRow = {
	id: string
	user_id: string
	provider_key: string
	display_name: string
	label: string
	auth_spec_json: string
	status: string
	account_id: string | null
	account_label: string | null
	scope_set: string | null
	metadata_json: string | null
	is_default: 0 | 1
	token_expires_at: string | null
	last_used_at: string | null
	created_at: string
	updated_at: string
}

export type ProviderConnectionSecretRow = {
	connection_id: string
	encrypted_secret_json: string
	created_at: string
	updated_at: string
}
