import { type RokuDiscoveredDevice } from '../types.ts'

type RokuDeviceInfoResponse = {
	udn?: string
	serialNumber?: string
	friendlyName?: string
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
		devices?: Array<RokuDeviceInfoResponse & { endpoint?: string }>
	}>(input.discoveryUrl)
	const now = new Date().toISOString()
	return (response.devices ?? []).map((device, index) => ({
		id:
			device.udn?.trim() ||
			device.serialNumber?.trim() ||
			`roku-${index.toString(10)}`,
		friendlyName:
			device.friendlyName?.trim() ||
			device.serialNumber?.trim() ||
			'Unknown Roku device',
		endpoint:
			device.endpoint?.trim() || `${normalizeBaseUrl(input.discoveryUrl)}/ecp/${index}`,
		lastSeenAt: now,
		controlEnabled: true,
	}))
}
