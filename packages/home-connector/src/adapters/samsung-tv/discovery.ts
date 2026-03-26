import { type HomeConnectorConfig } from '../../config.ts'
import { discoverMdnsServices } from '../../mdns.ts'
import {
	setSamsungTvDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import {
	type SamsungTvDeviceRecord,
	type SamsungTvDiscoveryResult,
	type SamsungTvMetadataLookupDiagnostic,
	type SamsungTvDiscoveryServiceDiagnostic,
} from './types.ts'

type DiscoveredSamsungService = SamsungTvDiscoveryServiceDiagnostic & {
	serviceUrl: string | null
}

function createSamsungDeviceId(input: {
	host: string
	rawDeviceInfo: Record<string, unknown> | null
}) {
	const device =
		(input.rawDeviceInfo['device'] as Record<string, unknown> | undefined) ?? {}
	const base =
		String(device['id'] ?? '') ||
		String(device['duid'] ?? '') ||
		String(device['wifiMac'] ?? '') ||
		input.host
	return `samsung-tv-${base.replaceAll(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`
}

function decodeSamsungTxtValue(value: string) {
	return value
		.replaceAll('\\ ', ' ')
		.replaceAll('\\&quot\\;', '"')
		.replaceAll('\\:', ':')
}

function parseSamsungTxtLine(line: string) {
	const values: Record<string, string> = {}
	const matches = line.matchAll(/(\w+)=((?:(?! \w+=).)+)/g)
	for (const match of matches) {
		values[match[1]] = decodeSamsungTxtValue(match[2].trim())
	}
	return values
}

function parseSamsungLookupOutput(
	instanceName: string,
	output: {
		host: string | null
		port: number | null
		txtLine: string
		raw: string
	},
): DiscoveredSamsungService {
	let txt: Record<string, string> = {}
	if (output.txtLine) {
		txt = parseSamsungTxtLine(output.txtLine)
	}
	return {
		instanceName,
		host: output.host,
		port: output.port,
		txt,
		serviceUrl: txt['se'] ?? null,
		raw: output.raw,
	}
}

async function fetchSamsungDeviceInfo(input: {
	service: DiscoveredSamsungService
}): Promise<{
	device: SamsungTvDeviceRecord | null
	lookup: SamsungTvMetadataLookupDiagnostic
}> {
	const deviceInfoUrl =
		input.service.serviceUrl ??
		(input.service.host && input.service.port
			? `http://${input.service.host}:${String(input.service.port)}/api/v2/`
			: '')
	if (!deviceInfoUrl) {
		return {
			device: null,
			lookup: {
				serviceUrl: input.service.serviceUrl ?? '',
				deviceInfoUrl: '',
				raw: null,
				parsed: null,
				error: 'Service did not provide a usable device-info URL.',
			},
		}
	}
	try {
		const response = await fetch(deviceInfoUrl)
		const raw = await response.text()
		const payload = JSON.parse(raw) as Record<string, unknown>
		const device =
			(payload['device'] as Record<string, unknown> | undefined) ?? {}
		const host = new URL(deviceInfoUrl).hostname
		return {
			device: {
				deviceId: createSamsungDeviceId({
					host,
					rawDeviceInfo: payload,
				}),
				name:
					String(
						device['name'] ?? payload['name'] ?? input.service.instanceName,
					) || input.service.instanceName,
				host,
				serviceUrl: input.service.serviceUrl,
				model: typeof device['model'] === 'string' ? device['model'] : null,
				modelName:
					typeof device['modelName'] === 'string' ? device['modelName'] : null,
				macAddress:
					typeof device['wifiMac'] === 'string' ? device['wifiMac'] : null,
				frameTvSupport:
					String(device['FrameTVSupport'] ?? '').toLowerCase() === 'true',
				tokenAuthSupport:
					String(device['TokenAuthSupport'] ?? '').toLowerCase() === 'true',
				powerState:
					typeof device['PowerState'] === 'string'
						? device['PowerState']
						: null,
				lastSeenAt: new Date().toISOString(),
				adopted: false,
				rawDeviceInfo: payload,
			},
			lookup: {
				serviceUrl: input.service.serviceUrl ?? '',
				deviceInfoUrl,
				raw,
				parsed: {
					name: typeof device['name'] === 'string' ? device['name'] : null,
					model: typeof device['model'] === 'string' ? device['model'] : null,
					modelName:
						typeof device['modelName'] === 'string'
							? device['modelName']
							: null,
					macAddress:
						typeof device['wifiMac'] === 'string' ? device['wifiMac'] : null,
					frameTvSupport:
						String(device['FrameTVSupport'] ?? '').toLowerCase() === 'true',
					tokenAuthSupport:
						String(device['TokenAuthSupport'] ?? '').toLowerCase() === 'true',
					powerState:
						typeof device['PowerState'] === 'string'
							? device['PowerState']
							: null,
				},
				error: null,
			},
		}
	} catch (error) {
		return {
			device: null,
			lookup: {
				serviceUrl: input.service.serviceUrl ?? '',
				deviceInfoUrl,
				raw: null,
				parsed: null,
				error: error instanceof Error ? error.message : String(error),
			},
		}
	}
}

async function discoverSamsungTvsFromJson(
	discoveryUrl: string,
): Promise<SamsungTvDiscoveryResult> {
	const response = await fetch(discoveryUrl)
	const payload = (await response.json()) as Record<string, unknown>
	const devices = Array.isArray(payload['devices'])
		? (payload['devices'] as Array<SamsungTvDeviceRecord>)
		: []
	return {
		devices,
		diagnostics: {
			protocol: 'json',
			discoveryUrl,
			scannedAt: new Date().toISOString(),
			jsonResponse: payload,
			services: [],
			metadataLookups: [],
		},
	}
}

async function discoverSamsungTvsFromMdns(
	discoveryUrl: string,
): Promise<SamsungTvDiscoveryResult> {
	const services = (
		await discoverMdnsServices({
			serviceType: '_samsungmsf._tcp',
			timeoutMs: 4_000,
		})
	).map((service) => parseSamsungLookupOutput(service.instanceName, service))
	const metadataLookups: Array<SamsungTvMetadataLookupDiagnostic> = []
	const devices: Array<SamsungTvDeviceRecord> = []
	for (const service of services) {
		const result = await fetchSamsungDeviceInfo({
			service,
		})
		metadataLookups.push(result.lookup)
		if (result.device) {
			devices.push(result.device)
		}
	}
	return {
		devices,
		diagnostics: {
			protocol: 'mdns',
			discoveryUrl,
			scannedAt: new Date().toISOString(),
			jsonResponse: null,
			services,
			metadataLookups,
		},
	}
}

export async function scanSamsungTvs(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	const result = config.samsungTvDiscoveryUrl.startsWith('http')
		? await discoverSamsungTvsFromJson(config.samsungTvDiscoveryUrl)
		: await discoverSamsungTvsFromMdns(config.samsungTvDiscoveryUrl)
	setSamsungTvDiscoveryDiagnostics(state, result.diagnostics)
	return result
}
