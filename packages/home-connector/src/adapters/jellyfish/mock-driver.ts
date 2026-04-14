import {
	type JellyfishDiscoveredController,
	jellyfishDefaultPort,
} from './types.ts'

const mockHost = 'jellyfish-f348.mock.local'
const mockControllerId = 'jellyfish-f348-local'
const mockHostname = 'JellyFish-F348.local'
const mockName = 'JellyFish-F348'

const mockPatternFileData = {
	colors: [0, 0, 255],
	spaceBetweenPixels: 1,
	effectBetweenPixels: 'No Color Transform',
	type: 'Color',
	skip: 1,
	numOfLeds: 1,
	runData: {
		speed: 1,
		brightness: 100,
		effect: 'No Effect',
		effectValue: 0,
		rgbAdj: [100, 100, 100],
	},
	direction: 'Center',
}

let mockLastRunPattern: Record<string, unknown> | null = null

export function resetMockJellyfishState() {
	mockLastRunPattern = null
}

export function isMockJellyfishHost(host: string) {
	return host.endsWith('.mock.local')
}

export function getMockJellyfishDiscoveryPayload() {
	const now = new Date().toISOString()
	return {
		controllers: [
			{
				controllerId: mockControllerId,
				name: mockName,
				hostname: mockHostname,
				host: mockHost,
				port: jellyfishDefaultPort,
				firmwareVersion: null,
				lastSeenAt: now,
				rawDiscovery: {
					mock: true,
					source: 'json',
				},
			} satisfies JellyfishDiscoveredController,
		],
	}
}

function buildZonesResponse() {
	return {
		cmd: 'fromCtlr',
		save: true,
		zones: {
			Zone: {
				numPixels: 755,
				portMap: [
					{
						ctlrName: mockHostname,
						phyEndIdx: 0,
						phyPort: 2,
						phyStartIdx: 124,
						zoneRGBStartIdx: 0,
					},
					{
						ctlrName: mockHostname,
						phyEndIdx: 274,
						phyPort: 4,
						phyStartIdx: 0,
						zoneRGBStartIdx: 125,
					},
					{
						ctlrName: mockHostname,
						phyEndIdx: 354,
						phyPort: 8,
						phyStartIdx: 0,
						zoneRGBStartIdx: 400,
					},
				],
			},
		},
	}
}

function buildPatternListResponse() {
	return {
		cmd: 'fromCtlr',
		patternFileList: [
			{ folders: 'Christmas', name: '', readOnly: false },
			{ folders: 'Christmas', name: 'Christmas Tree', readOnly: true },
			{ folders: 'Colors', name: '', readOnly: false },
			{ folders: 'Colors', name: 'Blue', readOnly: true },
		],
	}
}

function buildPatternFileDataResponse(folder: string, name: string) {
	return {
		cmd: 'fromCtlr',
		patternFileData: {
			folders: folder,
			name,
			jsonData: JSON.stringify(mockPatternFileData),
		},
	}
}

export async function sendMockJellyfishCommand(
	host: string,
	command: Record<string, unknown>,
) {
	if (!isMockJellyfishHost(host)) {
		throw new Error(`Unknown mock JellyFish host "${host}".`)
	}

	const get = command['get']
	if (
		command['cmd'] === 'toCtlrGet' &&
		Array.isArray(get) &&
		Array.isArray(get[0])
	) {
		const request = get[0] as Array<unknown>
		const resource = typeof request[0] === 'string' ? request[0] : ''
		switch (resource) {
			case 'zones':
				return buildZonesResponse()
			case 'patternFileList':
				return buildPatternListResponse()
			case 'patternFileData': {
				const folder = typeof request[1] === 'string' ? request[1] : 'Colors'
				const name = typeof request[2] === 'string' ? request[2] : 'Blue'
				return buildPatternFileDataResponse(folder, name)
			}
			default:
				throw new Error(
					`Unsupported mock JellyFish get resource "${resource}".`,
				)
		}
	}

	const runPattern = command['runPattern']
	if (
		command['cmd'] === 'toCtlrSet' &&
		runPattern &&
		typeof runPattern === 'object' &&
		!Array.isArray(runPattern)
	) {
		mockLastRunPattern = structuredClone(runPattern as Record<string, unknown>)
		return {
			cmd: 'fromCtlr',
			runPattern: mockLastRunPattern,
		}
	}

	throw new Error('Unsupported mock JellyFish command.')
}
