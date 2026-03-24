import { type RokuDiscoveredDevice } from '../types.ts'

type RokuDeviceInfoResponse = {
	id?: string
	udn?: string
	name?: string
	location?: string
	serialNumber?: string
	modelName?: string
	friendlyName?: string
	endpoint?: string
	adopted?: boolean
	isAdopted?: boolean
	lastSeenAt?: string
	controlEnabled?: boolean
}

function normalizeBaseUrl(url: string) {
	return url.endsWith('/') ? url.slice(0, -1) : url
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url)
	if (!response.ok) {
		throw new Error(`Request failed (${response.status}) for ${url}`)
	}
	return (await response.json()) as T
}

export async function discoverRokuDevices(input: {
	discoveryUrl: string
}): Promise<Array<RokuDiscoveredDevice>> {
	const response = await fetchJson<{
		devices?: Array<RokuDeviceInfoResponse>
	}>(input.discoveryUrl)
	const now = new Date().toISOString()
	return (response.devices ?? []).map((device, index) => ({
		id:
			device.id?.trim() ||
			device.udn?.trim() ||
			device.serialNumber?.trim() ||
			`roku-${index.toString(10)}`,
		name:
			device.name?.trim() ||
			device.friendlyName?.trim() ||
			device.serialNumber?.trim() ||
			'Unknown Roku device',
		location:
			device.location?.trim() ||
			device.endpoint?.trim() ||
			`${normalizeBaseUrl(input.discoveryUrl)}/ecp/${index}`,
		serialNumber: device.serialNumber?.trim() || null,
		modelName: device.modelName?.trim() || null,
		isAdopted: device.isAdopted ?? device.adopted ?? false,
		lastSeenAt: device.lastSeenAt ?? now,
		controlEnabled: device.controlEnabled ?? true,
	}))
}
