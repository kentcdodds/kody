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
	| 'set-wlan-password'
	| 'add-wlan'
	| 'edit-wlan'
	| 'clone-wlan'
	| 'delete-wlan'
	| 'add-wlan-group'
	| 'clone-wlan-group'
	| 'delete-wlan-group'
	| 'hide-ap-leds'
	| 'show-ap-leds'

export type AccessNetworksUnleashedWriteOperationResult = {
	operation: AccessNetworksUnleashedWriteOperationId
	target: string
	reason: string
	completedAt: string
}

export type AccessNetworksUnleashedAddWlanInput = {
	ssid: string
	passphrase: string
	name?: string
	saePassphrase?: string
	description?: string
}

export type AccessNetworksUnleashedEditWlanInput = {
	name: string
	passphrase?: string
	saePassphrase?: string
	description?: string
	ssid?: string
	enabled?: boolean
}

export type AccessNetworksUnleashedAddWlanGroupInput = {
	name: string
	description?: string
	wlans?: Array<string>
}

export type AccessNetworksUnleashedClient = {
	getSystemInfo(): Promise<AccessNetworksUnleashedRecord>
	listClients(): Promise<Array<AccessNetworksUnleashedRecord>>
	listAccessPoints(): Promise<Array<AccessNetworksUnleashedRecord>>
	listWlans(): Promise<Array<AccessNetworksUnleashedRecord>>
	listEvents(limit?: number): Promise<Array<AccessNetworksUnleashedRecord>>
	listBlockedClients(): Promise<Array<AccessNetworksUnleashedRecord>>
	listInactiveClients(): Promise<Array<AccessNetworksUnleashedRecord>>
	listActiveRogues(): Promise<Array<AccessNetworksUnleashedRecord>>
	listKnownRogues(
		limit?: number,
	): Promise<Array<AccessNetworksUnleashedRecord>>
	listBlockedRogues(
		limit?: number,
	): Promise<Array<AccessNetworksUnleashedRecord>>
	listApGroups(): Promise<Array<AccessNetworksUnleashedRecord>>
	listDpsks(): Promise<Array<AccessNetworksUnleashedRecord>>
	getMeshInfo(): Promise<AccessNetworksUnleashedRecord>
	getAlarms(limit?: number): Promise<Array<AccessNetworksUnleashedRecord>>
	getSyslog(): Promise<string>
	getVapStats(): Promise<Array<AccessNetworksUnleashedRecord>>
	getWlanGroupStats(): Promise<Array<AccessNetworksUnleashedRecord>>
	getApGroupStats(): Promise<Array<AccessNetworksUnleashedRecord>>
	blockClient(macAddress: string): Promise<void>
	unblockClient(macAddress: string): Promise<void>
	setWlanEnabled(name: string, enabled: boolean): Promise<void>
	setWlanPassword(
		name: string,
		passphrase: string,
		saePassphrase?: string,
	): Promise<void>
	addWlan(input: AccessNetworksUnleashedAddWlanInput): Promise<void>
	editWlan(input: AccessNetworksUnleashedEditWlanInput): Promise<void>
	cloneWlan(sourceName: string, newName: string, newSsid?: string): Promise<void>
	deleteWlan(name: string): Promise<void>
	addWlanGroup(input: AccessNetworksUnleashedAddWlanGroupInput): Promise<void>
	cloneWlanGroup(
		sourceName: string,
		newName: string,
		description?: string,
	): Promise<void>
	deleteWlanGroup(name: string): Promise<void>
	restartAccessPoint(macAddress: string): Promise<void>
	setAccessPointLeds(macAddress: string, enabled: boolean): Promise<void>
}
