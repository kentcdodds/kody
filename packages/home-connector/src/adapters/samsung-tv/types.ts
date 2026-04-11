export type SamsungTvDiscoveryServiceDiagnostic = {
	instanceName: string
	host: string | null
	/** IPv4 from mDNS when present; preferred for HTTP to the TV API. */
	address: string | null
	port: number | null
	txt: Record<string, string>
	raw: string
}

export type SamsungTvMetadataLookupDiagnostic = {
	serviceUrl: string
	deviceInfoUrl: string
	raw: string | null
	parsed: {
		name: string | null
		model: string | null
		modelName: string | null
		macAddress: string | null
		frameTvSupport: boolean
		tokenAuthSupport: boolean
		powerState: string | null
	} | null
	error: string | null
}

export type SamsungTvDiscoveryDiagnostics = {
	protocol: 'json' | 'mdns'
	discoveryUrl: string
	scannedAt: string
	jsonResponse: Record<string, unknown> | null
	services: Array<SamsungTvDiscoveryServiceDiagnostic>
	metadataLookups: Array<SamsungTvMetadataLookupDiagnostic>
}

export type SamsungTvDiscoveredDevice = {
	deviceId: string
	name: string
	host: string
	serviceUrl: string | null
	model: string | null
	modelName: string | null
	macAddress: string | null
	frameTvSupport: boolean
	tokenAuthSupport: boolean
	powerState: string | null
	lastSeenAt: string | null
	adopted: boolean
	rawDeviceInfo: Record<string, unknown> | null
}

export type SamsungTvDiscoveryResult = {
	devices: Array<SamsungTvDiscoveredDevice>
	diagnostics: SamsungTvDiscoveryDiagnostics
}

export type SamsungTvDeviceRecord = SamsungTvDiscoveredDevice

export type SamsungTvPersistedDevice = SamsungTvDeviceRecord & {
	token: string | null
	lastVerifiedAt: string | null
	lastAuthError: string | null
}

export type SamsungTvAppStatus = {
	appId: string
	name: string
	running: boolean
	visible: boolean
	version: string
}

export type SamsungTvKnownAppDefinition = {
	name: string
	ids: Array<string>
}

export type SamsungTvKnownAppStatus = {
	name: string
	appId: string | null
	installed: boolean
	status: SamsungTvAppStatus | null
}

export type SamsungTvArtModeStatus = {
	deviceId: string
	mode: 'on' | 'off'
}
