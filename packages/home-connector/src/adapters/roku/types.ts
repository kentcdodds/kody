export type RokuDiscoveredDevice = {
	id: string
	name: string
	location: string
	serialNumber: string | null
	modelName: string | null
	isAdopted: boolean
	lastSeenAt: string
	controlEnabled: boolean
}
