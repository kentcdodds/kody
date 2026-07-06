export type RemoteConnectorSettingRow = {
	id: string
	user_id: string
	instance_id: string
	enabled: boolean
	attached: boolean
	encrypted_shared_secret: string | null
	created_at: string
	updated_at: string
}

export type RemoteConnectorSettingMetadata = {
	id: string
	instanceId: string
	enabled: boolean
	attached: boolean
	hasSharedSecret: boolean
	createdAt: string
	updatedAt: string
}

export type RemoteConnectorSettingWithSharedSecret =
	RemoteConnectorSettingMetadata & {
		sharedSecret: string
	}
