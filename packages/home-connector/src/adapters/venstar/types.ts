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
