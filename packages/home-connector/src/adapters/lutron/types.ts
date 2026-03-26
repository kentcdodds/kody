export type LutronDiscoveryServiceDiagnostic = {
	instanceName: string
	host: string | null
	port: number | null
	address: string | null
	txt: Record<string, string>
	raw: string
}

export type LutronDiscoveryDiagnostics = {
	protocol: 'json' | 'mdns'
	discoveryUrl: string
	scannedAt: string
	jsonResponse: Record<string, unknown> | null
	services: Array<LutronDiscoveryServiceDiagnostic>
	errors: Array<string>
}

export type LutronDiscoveredProcessor = {
	processorId: string
	instanceName: string
	name: string
	host: string
	discoveryPort: number | null
	leapPort: number
	address: string | null
	serialNumber: string | null
	macAddress: string | null
	systemType: string | null
	codeVersion: string | null
	deviceClass: string | null
	claimStatus: string | null
	networkStatus: string | null
	firmwareStatus: string | null
	status: string | null
	lastSeenAt: string | null
	rawDiscovery: Record<string, unknown> | null
}

export type LutronDiscoveryResult = {
	processors: Array<LutronDiscoveredProcessor>
	diagnostics: LutronDiscoveryDiagnostics
}

export type LutronProcessorRecord = LutronDiscoveredProcessor

export type LutronPersistedProcessor = LutronProcessorRecord & {
	username: string | null
	password: string | null
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}

export type LutronArea = {
	processorId: string
	areaId: string
	href: string
	name: string
	parentHref: string | null
	parentAreaId: string | null
	isLeaf: boolean
	path: Array<string>
}

export type LutronZoneStatus = {
	level: number | null
	switchedLevel: 'On' | 'Off' | null
	vibrancy: number | null
	whiteTuningKelvin: number | null
	hue: number | null
	saturation: number | null
	statusAccuracy: string | null
	zoneLockState: string | null
}

export type LutronZone = {
	processorId: string
	areaId: string
	areaName: string
	areaPath: Array<string>
	zoneId: string
	href: string
	name: string
	controlType: string
	categoryType: string | null
	isLight: boolean
	availableControlTypes: Array<string>
	sortOrder: number | null
	status: LutronZoneStatus | null
}

export type LutronAssociatedGangedDevice = {
	deviceId: string
	href: string
	deviceType: string
	addressedState: string | null
	gangPosition: number | null
}

export type LutronControlStation = {
	processorId: string
	areaId: string
	areaName: string
	areaPath: Array<string>
	controlStationId: string
	href: string
	name: string
	sortOrder: number | null
	devices: Array<LutronAssociatedGangedDevice>
}

export type LutronButton = {
	processorId: string
	areaId: string
	areaName: string
	areaPath: Array<string>
	keypadDeviceId: string
	keypadHref: string
	keypadName: string
	keypadModelNumber: string | null
	keypadSerialNumber: string | null
	buttonGroupId: string
	buttonId: string
	href: string
	buttonNumber: number
	name: string
	label: string
	programmingModelType: string | null
	ledId: string | null
	ledHref: string | null
	ledState: 'On' | 'Off' | 'Unknown' | null
}

export type LutronVirtualButton = {
	processorId: string
	virtualButtonId: string
	href: string
	name: string
	isProgrammed: boolean
}

export type LutronSceneButton =
	| ({
			kind: 'keypad'
	  } & LutronButton)
	| ({
			kind: 'virtual'
	  } & LutronVirtualButton)

export type LutronInventory = {
	processor: LutronPersistedProcessor
	areas: Array<LutronArea>
	zones: Array<LutronZone>
	controlStations: Array<LutronControlStation>
	buttons: Array<LutronButton>
	virtualButtons: Array<LutronVirtualButton>
	sceneButtons: Array<LutronSceneButton>
}
