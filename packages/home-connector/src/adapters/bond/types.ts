export type BondDiscoveryProtocol = 'mdns' | 'json'

export type BondDiscoveryServiceDiagnostic = {
	instanceName: string
	host: string | null
	port: number | null
	address: string | null
	txtLine: string
	raw: string
}

export type BondDiscoveryDiagnostics = {
	protocol: BondDiscoveryProtocol
	discoveryUrl: string
	scannedAt: string
	jsonResponse: Record<string, unknown> | null
	services: Array<BondDiscoveryServiceDiagnostic>
	errors: Array<string>
}

export type BondDiscoveredBridge = {
	bridgeId: string
	bondid: string
	instanceName: string
	host: string
	port: number
	address: string | null
	model: string | null
	fwVer: string | null
	lastSeenAt: string
	rawDiscovery: Record<string, unknown>
}

export type BondBridgeRecord = BondDiscoveredBridge & {
	adopted: boolean
	hasStoredToken: boolean
}

export type BondPersistedBridge = {
	bridgeId: string
	bondid: string
	instanceName: string
	host: string
	port: number
	model: string | null
	fwVer: string | null
	adopted: boolean
	lastSeenAt: string | null
	hasStoredToken: boolean
	rawDiscovery: Record<string, unknown> | null
}

export type BondDeviceSummary = {
	deviceId: string
	name: string
	type: string
	location: string | null
	template: string | null
	subtype: string | null
	actions: Array<string>
}

export type BondGroupSummary = {
	groupId: string
	name: string
	devices: Array<string>
	actions: Array<string>
}
