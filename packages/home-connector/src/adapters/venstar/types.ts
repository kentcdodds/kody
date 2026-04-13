export type VenstarInfoResponse = {
	name?: string
	mode: number
	state: number
	fan: number
	spacetemp: number
	heattemp: number
	cooltemp: number
	humidity?: number
	setpointdelta?: number
	schedule?: number
	away?: number
	tempunits?: number
	[key: string]: unknown
}

export type VenstarSensorEntry = {
	name?: string
	temp?: number
	hum?: number
	humidity?: number
	type?: string
	enabled?: number
	[key: string]: unknown
}

export type VenstarSensorsResponse = {
	sensors: Array<VenstarSensorEntry>
}

export type VenstarRuntimeEntry = {
	ts?: string
	heat?: number
	cool?: number
	aux?: number
	fan?: number
	[key: string]: unknown
}

export type VenstarRuntimesResponse = {
	runtimes: Array<VenstarRuntimeEntry>
}

export type VenstarControlRequest = {
	mode?: number
	fan?: number
	heattemp?: number
	cooltemp?: number
	[key: string]: unknown
}

export type VenstarSettingsRequest = {
	away?: number
	schedule?: number
	humidify?: number
	dehumidify?: number
	tempunits?: number
	[key: string]: unknown
}

export type VenstarControlResponse = {
	success?: boolean
	[key: string]: unknown
}

export type VenstarSettingsResponse = {
	success?: boolean
	[key: string]: unknown
}

export type VenstarDiscoveredThermostat = {
	name: string
	ip: string
	location: string
	usn: string | null
	lastSeenAt: string
	rawDiscovery: Record<string, unknown> | null
}

export type VenstarSsdpHitDiagnostic = {
	receivedAt: string
	remoteAddress: string
	remotePort: number
	raw: string
	location: string | null
	usn: string | null
	server: string | null
}

export type VenstarInfoLookupDiagnostic = {
	location: string
	infoUrl: string
	raw: Record<string, unknown> | null
	parsed: {
		name: string
		ip: string
		mode: number | null
		spacetemp: number | null
		humidity: number | null
	} | null
	error: string | null
}

export type VenstarDiscoveryDiagnostics = {
	protocol: 'json' | 'ssdp'
	discoveryUrl: string
	scannedAt: string
	jsonResponse: Record<string, unknown> | null
	ssdpHits: Array<VenstarSsdpHitDiagnostic>
	infoLookups: Array<VenstarInfoLookupDiagnostic>
}
