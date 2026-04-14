export const jellyfishDefaultPort = 9000

export type JellyfishDiscoveredController = {
	controllerId: string
	name: string
	hostname: string
	host: string
	port: number
	firmwareVersion: string | null
	lastSeenAt: string
	rawDiscovery: Record<string, unknown>
}

export type JellyfishPersistedController = {
	controllerId: string
	name: string
	hostname: string
	host: string
	port: number
	firmwareVersion: string | null
	lastSeenAt: string | null
	lastConnectedAt: string | null
	lastError: string | null
}

export type JellyfishZone = {
	name: string
	numPixels: number | null
	portMap: Array<Record<string, unknown>>
}

export type JellyfishPattern = {
	path: string
	folder: string
	name: string
	readOnly: boolean
}

export type JellyfishPatternData = {
	path: string
	folder: string
	name: string
	data: Record<string, unknown>
	rawJsonData: string
}

export type JellyfishProbeDiagnostic = {
	host: string
	port: number
	matched: boolean
	hostname: string | null
	response: Record<string, unknown> | null
	error: string | null
}

export type JellyfishSubnetProbeSummary = {
	cidrs: Array<string>
	hostsProbed: number
	portOpenCount: number
	jellyfishMatches: number
}

export type JellyfishDiscoveryDiagnostics = {
	protocol: 'json' | 'subnet'
	discoveryUrl: string
	scannedAt: string
	jsonResponse: Record<string, unknown> | null
	probeResults: Array<JellyfishProbeDiagnostic>
	subnetProbe: JellyfishSubnetProbeSummary | null
}
