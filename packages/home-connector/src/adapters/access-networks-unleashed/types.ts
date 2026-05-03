export type AccessNetworksUnleashedRecord = Record<
	string,
	string | number | boolean | null
>

export type AccessNetworksUnleashedDiscoveredController = {
	controllerId: string
	name: string
	host: string
	loginUrl: string
	lastSeenAt: string | null
	rawDiscovery: Record<string, unknown> | null
}

export type AccessNetworksUnleashedPersistedController =
	AccessNetworksUnleashedDiscoveredController & {
		adopted: boolean
		username: string | null
		password: string | null
		lastAuthenticatedAt: string | null
		lastAuthError: string | null
	}

export type AccessNetworksUnleashedPublicController =
	AccessNetworksUnleashedDiscoveredController & {
		adopted: boolean
		hasStoredCredentials: boolean
		lastAuthenticatedAt: string | null
		lastAuthError: string | null
	}

export type AccessNetworksUnleashedProbeDiagnostic = {
	host: string
	url: string
	matched: boolean
	status: number | null
	location: string | null
	matchReason: 'redirect' | 'login-page' | null
	error: string | null
	bodySnippet: string | null
}

export type AccessNetworksUnleashedSubnetProbeSummary = {
	cidrs: Array<string>
	hostsProbed: number
	controllerMatches: number
}

export type AccessNetworksUnleashedDiscoveryDiagnostics = {
	protocol: 'subnet'
	discoveryUrl: string
	scannedAt: string
	probes: Array<AccessNetworksUnleashedProbeDiagnostic>
	subnetProbe: AccessNetworksUnleashedSubnetProbeSummary
}

export type AccessNetworksUnleashedDiscoveryResult = {
	controllers: Array<AccessNetworksUnleashedDiscoveredController>
	diagnostics: AccessNetworksUnleashedDiscoveryDiagnostics
}

export type AccessNetworksUnleashedConfigStatus = {
	configured: boolean
	adoptedControllerId: string | null
	host: string | null
	hasAdoptedController: boolean
	hasStoredCredentials: boolean
	allowInsecureTls: boolean
	missingRequirements: Array<'controller' | 'credentials'>
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}

export type AccessNetworksUnleashedSystemStatus = {
	config: AccessNetworksUnleashedConfigStatus
	controller: AccessNetworksUnleashedPublicController | null
	controllers: Array<AccessNetworksUnleashedPublicController>
	diagnostics: AccessNetworksUnleashedDiscoveryDiagnostics | null
	error: string | null
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
