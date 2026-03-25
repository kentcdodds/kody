export type ConnectionDraftRow = {
	id: string
	user_id: string
	provider_key: string
	display_name: string
	label: string | null
	auth_spec_json: string
	status: string
	state_json: string | null
	error_message: string | null
	created_at: string
	updated_at: string
	expires_at: string
}

export type ConnectionDraftSecretRow = {
	draft_id: string
	secret_name: string
	encrypted_value: string
	created_at: string
	updated_at: string
}
