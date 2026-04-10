import { createSocket } from 'node:dgram'
import { type HomeConnectorConfig } from '../../config.ts'
import {
	setSonosDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import {
	type SonosDescriptionLookupDiagnostic,
	type SonosDiscoveryDiagnostics,
	type SonosPlayerRecord,
	type SonosSsdpHitDiagnostic,
} from './types.ts'

type SonosSsdpDiscoveryConfig = {
	address: string
	port: number
	searchTarget: string
	mx: number
	timeoutMs: number
}

type SonosDescriptionLookup = {
	player: SonosPlayerRecord | null
	diagnostic: SonosDescriptionLookupDiagnostic
}

const sonosFetchTimeoutMs = 10_000

function parseNumberOrDefault(value: string | null, fallback: number) {
	if (!value) return fallback
	const parsed = Number.parseInt(value, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseSsdpDiscoveryUrl(discoveryUrl: string): SonosSsdpDiscoveryConfig {
	const url = new URL(discoveryUrl)
	if (url.protocol !== 'ssdp:') {
		throw new Error(`Unsupported Sonos discovery protocol: ${url.protocol}`)
	}
	return {
		address: url.hostname || '239.255.255.250',
		port: parseNumberOrDefault(url.port || null, 1900),
		searchTarget:
			url.searchParams.get('st')?.trim() ||
			'urn:schemas-upnp-org:device:ZonePlayer:1',
		mx: parseNumberOrDefault(url.searchParams.get('mx'), 2),
		timeoutMs: parseNumberOrDefault(url.searchParams.get('timeoutMs'), 3_000),
	}
}

function createSsdpSearchMessage(input: SonosSsdpDiscoveryConfig) {
	return [
		'M-SEARCH * HTTP/1.1',
		`HOST: ${input.address}:${input.port}`,
		'MAN: "ssdp:discover"',
		`MX: ${input.mx}`,
		`ST: ${input.searchTarget}`,
		'',
		'',
	].join('\r\n')
}

function isTimeoutError(error: unknown) {
	return (
		error instanceof Error &&
		(error.name === 'TimeoutError' || error.name === 'AbortError')
	)
}

function parseHttpLikeHeaders(message: string) {
	const headers = new Map<string, string>()
	for (const line of message.split(/\r?\n/)) {
		const separatorIndex = line.indexOf(':')
		if (separatorIndex === -1) continue
		const key = line.slice(0, separatorIndex).trim().toLowerCase()
		const value = line.slice(separatorIndex + 1).trim()
		if (!key || !value) continue
		headers.set(key, value)
	}
	return headers
}

function readXmlTag(xml: string, tagName: string) {
	const match = xml.match(
		new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'),
	)
	return match?.[1]?.trim() || null
}

function hasXmlTag(xml: string, tagName: string) {
	return new RegExp(`<${tagName}>`, 'i').test(xml)
}

function createSonosPlayerId(input: {
	udn: string | null
	serialNum: string | null
	host: string
}) {
	const rawBase = input.udn || input.serialNum || input.host
	return `sonos-${rawBase
		.replace(/^uuid:/i, '')
		.replaceAll(/[^a-zA-Z0-9]+/g, '-')
		.toLowerCase()}`
}

function parseDescriptionXml(input: {
	xml: string
	descriptionUrl: string
	householdId: string | null
}) {
	const host = new URL(input.descriptionUrl).hostname
	const udn = readXmlTag(input.xml, 'UDN')
	const serialNum = readXmlTag(input.xml, 'serialNum')
	const audioInputSupported =
		hasXmlTag(input.xml, 'roomName') &&
		/urn:schemas-upnp-org:service:AudioIn:1/i.test(input.xml)
	return {
		playerId: createSonosPlayerId({
			udn,
			serialNum,
			host,
		}),
		udn: udn ?? `uuid:${host}`,
		roomName: readXmlTag(input.xml, 'roomName') || host,
		displayName: readXmlTag(input.xml, 'displayName'),
		friendlyName: readXmlTag(input.xml, 'friendlyName') || host,
		modelName: readXmlTag(input.xml, 'modelName'),
		modelNumber: readXmlTag(input.xml, 'modelNumber'),
		serialNum,
		householdId:
			input.householdId ||
			readXmlTag(input.xml, 'householdId') ||
			readXmlTag(input.xml, 'HouseholdControlID'),
		host,
		descriptionUrl: input.descriptionUrl,
		audioInputSupported,
		adopted: false,
		lastSeenAt: new Date().toISOString(),
		rawDescriptionXml: input.xml,
	} satisfies SonosPlayerRecord
}

async function fetchText(url: string) {
	let response: Response
	try {
		response = await fetch(url, {
			signal: AbortSignal.timeout(sonosFetchTimeoutMs),
		})
	} catch (error) {
		if (isTimeoutError(error)) {
			throw new Error(
				`Request timed out after ${sonosFetchTimeoutMs}ms for ${url}`,
			)
		}
		throw error
	}
	if (!response.ok) {
		throw new Error(`Request failed (${response.status}) for ${url}`)
	}
	return await response.text()
}

async function fetchJson<T>(url: string) {
	let response: Response
	try {
		response = await fetch(url, {
			signal: AbortSignal.timeout(sonosFetchTimeoutMs),
		})
	} catch (error) {
		if (isTimeoutError(error)) {
			throw new Error(
				`Request timed out after ${sonosFetchTimeoutMs}ms for ${url}`,
			)
		}
		throw error
	}
	if (!response.ok) {
		throw new Error(`Request failed (${response.status}) for ${url}`)
	}
	return (await response.json()) as T
}

async function discoverSonosPlayersFromJson(discoveryUrl: string): Promise<{
	players: Array<SonosPlayerRecord>
	diagnostics: SonosDiscoveryDiagnostics
}> {
	const payload = await fetchJson<{
		players?: Array<SonosPlayerRecord>
	}>(discoveryUrl)
	return {
		players: payload.players ?? [],
		diagnostics: {
			protocol: 'json',
			discoveryUrl,
			scannedAt: new Date().toISOString(),
			jsonResponse: payload as Record<string, unknown>,
			ssdpHits: [],
			descriptionLookups: [],
		},
	}
}

async function discoverSsdpLocations(input: {
	discoveryUrl: string
	now: string
}): Promise<{
	locations: Array<{ descriptionUrl: string; householdId: string | null }>
	hits: Array<SonosSsdpHitDiagnostic>
}> {
	const config = parseSsdpDiscoveryUrl(input.discoveryUrl)
	const searchMessage = Buffer.from(createSsdpSearchMessage(config))
	const socket = createSocket('udp4')
	const locations = new Map<
		string,
		{ descriptionUrl: string; householdId: string | null }
	>()
	const hits: Array<SonosSsdpHitDiagnostic> = []

	socket.on('message', (message, remote) => {
		const raw = message.toString()
		const headers = parseHttpLikeHeaders(raw)
		const locationHeader = headers.get('location')
		const householdId = headers.get('x-rincon-household') ?? null
		hits.push({
			receivedAt: input.now,
			remoteAddress: remote.address,
			remotePort: remote.port,
			raw,
			location: locationHeader ?? null,
			usn: headers.get('usn') ?? null,
			server: headers.get('server') ?? null,
			householdId,
		})
		if (!locationHeader || locations.has(locationHeader)) return
		locations.set(locationHeader, {
			descriptionUrl: locationHeader,
			householdId,
		})
	})

	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false
			function cleanup() {
				socket.off('error', handleError)
			}
			function handleError(error: Error) {
				if (settled) return
				settled = true
				cleanup()
				reject(error)
			}
			socket.on('error', handleError)
			socket.bind(0, () => {
				socket.send(searchMessage, config.port, config.address, (error) => {
					if (error) {
						handleError(error)
						return
					}
					setTimeout(() => {
						if (settled) return
						settled = true
						cleanup()
						resolve()
					}, config.timeoutMs)
				})
			})
		})
	} finally {
		socket.close()
	}

	return {
		locations: [...locations.values()],
		hits,
	}
}

async function fetchDescriptionLookup(input: {
	descriptionUrl: string
	householdId: string | null
}): Promise<SonosDescriptionLookup> {
	try {
		const xml = await fetchText(input.descriptionUrl)
		const player = parseDescriptionXml({
			xml,
			descriptionUrl: input.descriptionUrl,
			householdId: input.householdId,
		})
		return {
			player,
			diagnostic: {
				descriptionUrl: input.descriptionUrl,
				host: player.host,
				raw: xml,
				parsed: {
					playerId: player.playerId,
					roomName: player.roomName,
					displayName: player.displayName,
					friendlyName: player.friendlyName,
					modelName: player.modelName,
					modelNumber: player.modelNumber,
					serialNum: player.serialNum,
					householdId: player.householdId,
					audioInputSupported: player.audioInputSupported,
				},
				error: null,
			},
		}
	} catch (error) {
		return {
			player: null,
			diagnostic: {
				descriptionUrl: input.descriptionUrl,
				host: null,
				raw: null,
				parsed: null,
				error: error instanceof Error ? error.message : String(error),
			},
		}
	}
}

async function discoverSonosPlayersFromSsdp(discoveryUrl: string): Promise<{
	players: Array<SonosPlayerRecord>
	diagnostics: SonosDiscoveryDiagnostics
}> {
	const now = new Date().toISOString()
	const { locations, hits } = await discoverSsdpLocations({
		discoveryUrl,
		now,
	})
	const players: Array<SonosPlayerRecord> = []
	const descriptionLookups: Array<SonosDescriptionLookupDiagnostic> = []
	for (const location of locations) {
		const lookup = await fetchDescriptionLookup(location)
		descriptionLookups.push(lookup.diagnostic)
		if (lookup.player) {
			players.push(lookup.player)
		}
	}
	return {
		players,
		diagnostics: {
			protocol: 'ssdp',
			discoveryUrl,
			scannedAt: now,
			jsonResponse: null,
			ssdpHits: hits,
			descriptionLookups,
		},
	}
}

export async function scanSonosPlayers(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	const result = config.sonosDiscoveryUrl.startsWith('http')
		? await discoverSonosPlayersFromJson(config.sonosDiscoveryUrl)
		: await discoverSonosPlayersFromSsdp(config.sonosDiscoveryUrl)
	setSonosDiscoveryDiagnostics(state, result.diagnostics)
	return result
}
