export type AccessNetworksUnleashedConfigStatus = {
	configured: boolean
	host: string | null
	usernameConfigured: boolean
	passwordConfigured: boolean
	allowInsecureTls: boolean
	missingFields: Array<string>
}

export type AccessNetworksUnleashedRecord = Record<
	string,
	string | number | boolean | null
>

export type AccessNetworksUnleashedSystemStatus = {
	config: AccessNetworksUnleashedConfigStatus
	system: AccessNetworksUnleashedRecord
	aps: Array<AccessNetworksUnleashedRecord>
	wlans: Array<AccessNetworksUnleashedRecord>
	clients: Array<AccessNetworksUnleashedRecord>
	events: Array<AccessNetworksUnleashedRecord>
}

export type AccessNetworksUnleashedWriteOperationId =
	| 'block-client'
	| 'unblock-client'
	| 'enable-wlan'
	| 'disable-wlan'
	| 'restart-ap'
	| 'set-ap-leds'

export type AccessNetworksUnleashedWriteOperationResult = {
	operation: AccessNetworksUnleashedWriteOperationId
	target: string
	reason: string
	completedAt: string
}

export type AccessNetworksUnleashedClient = {
	getSystemInfo(): Promise<AccessNetworksUnleashedRecord>
	listClients(): Promise<Array<AccessNetworksUnleashedRecord>>
	listAccessPoints(): Promise<Array<AccessNetworksUnleashedRecord>>
	listWlans(): Promise<Array<AccessNetworksUnleashedRecord>>
	listEvents(limit?: number): Promise<Array<AccessNetworksUnleashedRecord>>
	blockClient(macAddress: string): Promise<void>
	unblockClient(macAddress: string): Promise<void>
	setWlanEnabled(name: string, enabled: boolean): Promise<void>
	restartAccessPoint(macAddress: string): Promise<void>
	setAccessPointLeds(macAddress: string, enabled: boolean): Promise<void>
}
