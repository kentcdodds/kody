import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { randomUUID } from 'node:crypto'
import {
	type LutronArea,
	type LutronButton,
	type LutronControlStation,
	type LutronPersistedProcessor,
	type LutronVirtualButton,
	type LutronZone,
	type LutronZoneStatus,
	type LutronInventory,
	type LutronAssociatedGangedDevice,
} from './types.ts'

type LeapResponse = {
	CommuniqueType?: string
	Header?: {
		StatusCode?: string
		Url?: string
		ClientTag?: string
		MessageBodyType?: string
	}
	Body?: Record<string, unknown>
}

type LutronCredentials = {
	username: string
	password: string
}

type LeapClient = {
	login(credentials: LutronCredentials): Promise<void>
	read(url: string): Promise<LeapResponse>
	create(url: string, body: Record<string, unknown>): Promise<LeapResponse>
	close(): Promise<void>
}

type LutronInventoryNode = {
	area: LutronArea
}

function createTlsSocket(input: { host: string; port: number }) {
	return new Promise<TLSSocket>((resolve, reject) => {
		const socket = tlsConnect({
			host: input.host,
			port: input.port,
			rejectUnauthorized: false,
			timeout: 5_000,
		})

		socket.once('secureConnect', () => {
			socket.removeAllListeners('error')
			socket.removeAllListeners('timeout')
			resolve(socket)
		})

		socket.once('error', (error) => {
			socket.destroy()
			reject(error)
		})

		socket.once('timeout', () => {
			socket.destroy()
			reject(new Error(`Lutron TLS connection to ${input.host}:${String(input.port)} timed out.`))
		})
	})
}

function readNextLine(socket: TLSSocket) {
	return new Promise<string>((resolve, reject) => {
		const chunks: Array<Buffer> = []

		function cleanup() {
			socket.off('data', onData)
			socket.off('error', onError)
			socket.off('close', onClose)
		}

		function finish() {
			cleanup()
			resolve(Buffer.concat(chunks).toString('utf8').trim())
		}

		function onData(chunk: Buffer) {
			chunks.push(chunk)
			if (chunk.includes(0x0a)) {
				finish()
			}
		}

		function onError(error: Error) {
			cleanup()
			reject(error)
		}

		function onClose() {
			finish()
		}

		socket.on('data', onData)
		socket.once('error', onError)
		socket.once('close', onClose)
	})
}

async function sendLeapMessage(
	socket: TLSSocket,
	input: {
		communiqueType: 'ReadRequest' | 'UpdateRequest' | 'CreateRequest'
		url: string
		body?: Record<string, unknown>
	},
) {
	const request = {
		CommuniqueType: input.communiqueType,
		Header: {
			ClientTag: randomUUID(),
			Url: input.url,
		},
		...(input.body ? { Body: input.body } : {}),
	}
	socket.write(`${JSON.stringify(request)}\n`)
	const raw = await readNextLine(socket)
	if (!raw) {
		throw new Error(`Lutron LEAP request to ${input.url} returned no response.`)
	}

	const response = JSON.parse(raw) as LeapResponse
	return response
}

function extractResourceId(href: string) {
	return href.split('/').filter(Boolean).at(-1) ?? href
}

function normalizeAreaPath(path: Array<string>) {
	return path.filter((segment) => segment.length > 0)
}

function getStatusCode(response: LeapResponse) {
	return response.Header?.StatusCode ?? ''
}

function isNoContent(response: LeapResponse) {
	return getStatusCode(response).startsWith('204')
}

function assertSuccessfulResponse(response: LeapResponse, action: string) {
	const statusCode = getStatusCode(response)
	if (statusCode.startsWith('200') || statusCode.startsWith('204')) {
		return
	}

	const details = response.Body ? JSON.stringify(response.Body) : statusCode
	throw new Error(`Lutron ${action} failed with ${statusCode || 'unknown status'}: ${details}`)
}

export async function createLutronLeapClient(
	processor: Pick<LutronPersistedProcessor, 'host' | 'leapPort'>,
): Promise<LeapClient> {
	const socket = await createTlsSocket({
		host: processor.host,
		port: processor.leapPort,
	})

	return {
		async login(credentials) {
			const response = await sendLeapMessage(socket, {
				communiqueType: 'UpdateRequest',
				url: '/login',
				body: {
					Login: {
						ContextType: 'Application',
						LoginId: credentials.username,
						Password: credentials.password,
					},
				},
			})
			assertSuccessfulResponse(response, 'login')
		},
		async read(url) {
			return await sendLeapMessage(socket, {
				communiqueType: 'ReadRequest',
				url,
			})
		},
		async create(url, body) {
			return await sendLeapMessage(socket, {
				communiqueType: 'CreateRequest',
				url,
				body,
			})
		},
		async close() {
			await new Promise<void>((resolve) => {
				socket.end(() => resolve())
			})
		},
	}
}

function mapZoneStatus(response: LeapResponse): LutronZoneStatus | null {
	const zoneStatus = (response.Body?.['ZoneStatus'] as Record<string, unknown> | undefined) ?? null
	if (!zoneStatus) return null

	const colorTuningStatus =
		(zoneStatus['ColorTuningStatus'] as Record<string, unknown> | undefined) ?? {}
	const hsv =
		(colorTuningStatus['HSVTuningLevel'] as Record<string, unknown> | undefined) ?? {}
	const white =
		(colorTuningStatus['WhiteTuningLevel'] as Record<string, unknown> | undefined) ?? {}

	return {
		level: typeof zoneStatus['Level'] === 'number' ? zoneStatus['Level'] : null,
		switchedLevel:
			zoneStatus['SwitchedLevel'] === 'On' || zoneStatus['SwitchedLevel'] === 'Off'
				? zoneStatus['SwitchedLevel']
				: null,
		vibrancy: typeof zoneStatus['Vibrancy'] === 'number' ? zoneStatus['Vibrancy'] : null,
		whiteTuningKelvin:
			typeof white['Kelvin'] === 'number' ? white['Kelvin'] : null,
		hue: typeof hsv['Hue'] === 'number' ? hsv['Hue'] : null,
		saturation: typeof hsv['Saturation'] === 'number' ? hsv['Saturation'] : null,
		statusAccuracy:
			typeof zoneStatus['StatusAccuracy'] === 'string'
				? zoneStatus['StatusAccuracy']
				: null,
		zoneLockState:
			typeof zoneStatus['ZoneLockState'] === 'string'
				? zoneStatus['ZoneLockState']
				: null,
	}
}

function mapLedState(response: LeapResponse) {
	const ledStatus = (response.Body?.['LEDStatus'] as Record<string, unknown> | undefined) ?? null
	if (!ledStatus) return null
	return ledStatus['State'] === 'On' || ledStatus['State'] === 'Off'
		? ledStatus['State']
		: 'Unknown'
}

function mapAssociatedGangedDevices(
	devices: Array<Record<string, unknown>>,
): Array<LutronAssociatedGangedDevice> {
	return devices.flatMap((entry) => {
		const device = (entry['Device'] as Record<string, unknown> | undefined) ?? null
		if (!device || typeof device['href'] !== 'string') return []
		return [
			{
				deviceId: extractResourceId(device['href']),
				href: device['href'],
				deviceType:
					typeof device['DeviceType'] === 'string' ? device['DeviceType'] : 'Unknown',
				addressedState:
					typeof device['AddressedState'] === 'string'
						? device['AddressedState']
						: null,
				gangPosition:
					typeof entry['GangPosition'] === 'number' ? entry['GangPosition'] : null,
			},
		]
	})
}

async function fetchLedState(client: LeapClient, ledHref: string | null) {
	if (!ledHref) return null
	const response = await client.read(`${ledHref}/status`)
	if (isNoContent(response)) return null
	assertSuccessfulResponse(response, `${ledHref} status read`)
	return mapLedState(response)
}

async function buildAreaTree(
	client: LeapClient,
	processorId: string,
): Promise<Array<LutronArea>> {
	const rootResponse = await client.read('/area/rootarea')
	assertSuccessfulResponse(rootResponse, 'root area read')

	const rootArea = (rootResponse.Body?.['Area'] as Record<string, unknown> | undefined) ?? null
	if (!rootArea || typeof rootArea['href'] !== 'string') {
		throw new Error('Lutron root area response did not include an Area payload.')
	}

	const rootId = extractResourceId(rootArea['href'])
	const rootName = typeof rootArea['Name'] === 'string' ? rootArea['Name'] : rootId
	const areas = new Map<string, LutronArea>()
	const queue: Array<LutronInventoryNode> = [
		{
			area: {
				processorId,
				areaId: rootId,
				href: rootArea['href'],
				name: rootName,
				parentHref: null,
				parentAreaId: null,
				isLeaf: Boolean(rootArea['IsLeaf']),
				path: [rootName],
			},
		},
	]

	while (queue.length > 0) {
		const current = queue.shift()!.area
		areas.set(current.areaId, current)
		const response = await client.read(`${current.href}/childarea/summary`)
		if (isNoContent(response)) continue
		assertSuccessfulResponse(response, `${current.href} child area read`)
		const summaries = (response.Body?.['AreaSummaries'] as Array<Record<string, unknown>> | undefined) ?? []

		for (const summary of summaries) {
			if (typeof summary['href'] !== 'string') continue
			const childId = extractResourceId(summary['href'])
			const childName = typeof summary['Name'] === 'string' ? summary['Name'] : childId
			const childArea: LutronArea = {
				processorId,
				areaId: childId,
				href: summary['href'],
				name: childName,
				parentHref: current.href,
				parentAreaId: current.areaId,
				isLeaf: Boolean(summary['IsLeaf']),
				path: normalizeAreaPath([...current.path, childName]),
			}
			queue.push({ area: childArea })
		}
	}

	return [...areas.values()].sort((left, right) => left.path.join('/').localeCompare(right.path.join('/')))
}

async function buildZones(
	client: LeapClient,
	processorId: string,
	areas: Array<LutronArea>,
): Promise<Array<LutronZone>> {
	const zones: Array<LutronZone> = []

	for (const area of areas) {
		const response = await client.read(`${area.href}/associatedzone`)
		if (isNoContent(response)) continue
		assertSuccessfulResponse(response, `${area.href} associated zone read`)
		const entries = (response.Body?.['Zones'] as Array<Record<string, unknown>> | undefined) ?? []

		for (const zone of entries) {
			if (typeof zone['href'] !== 'string') continue
			const statusResponse = await client.read(`${zone['href']}/status`)
			assertSuccessfulResponse(statusResponse, `${zone['href']} status read`)
			zones.push({
				processorId,
				areaId: area.areaId,
				areaName: area.name,
				areaPath: area.path,
				zoneId: extractResourceId(zone['href']),
				href: zone['href'],
				name: typeof zone['Name'] === 'string' ? zone['Name'] : extractResourceId(zone['href']),
				controlType:
					typeof zone['ControlType'] === 'string' ? zone['ControlType'] : 'Unknown',
				categoryType:
					typeof (zone['Category'] as Record<string, unknown> | undefined)?.['Type'] ===
					'string'
						? ((zone['Category'] as Record<string, unknown>)['Type'] as string)
						: null,
				isLight: Boolean(
					(zone['Category'] as Record<string, unknown> | undefined)?.['IsLight'],
				),
				availableControlTypes: Array.isArray(zone['AvailableControlTypes'])
					? zone['AvailableControlTypes'].filter((entry): entry is string => typeof entry === 'string')
					: [],
				sortOrder: typeof zone['SortOrder'] === 'number' ? zone['SortOrder'] : null,
				status: mapZoneStatus(statusResponse),
			})
		}
	}

	return zones.sort(
		(left, right) =>
			left.areaPath.join('/').localeCompare(right.areaPath.join('/')) ||
			(left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
			left.name.localeCompare(right.name),
	)
}

async function buildControlStations(
	client: LeapClient,
	processorId: string,
	areas: Array<LutronArea>,
): Promise<Array<LutronControlStation>> {
	const stations: Array<LutronControlStation> = []

	for (const area of areas) {
		const response = await client.read(`${area.href}/associatedcontrolstation`)
		if (isNoContent(response)) continue
		assertSuccessfulResponse(response, `${area.href} associated control station read`)
		const entries =
			(response.Body?.['ControlStations'] as Array<Record<string, unknown>> | undefined) ?? []

		for (const station of entries) {
			if (typeof station['href'] !== 'string') continue
			stations.push({
				processorId,
				areaId: area.areaId,
				areaName: area.name,
				areaPath: area.path,
				controlStationId: extractResourceId(station['href']),
				href: station['href'],
				name:
					typeof station['Name'] === 'string'
						? station['Name']
						: extractResourceId(station['href']),
				sortOrder: typeof station['SortOrder'] === 'number' ? station['SortOrder'] : null,
				devices: mapAssociatedGangedDevices(
					(Array.isArray(station['AssociatedGangedDevices'])
						? station['AssociatedGangedDevices']
						: []) as Array<Record<string, unknown>>,
				),
			})
		}
	}

	return stations.sort(
		(left, right) =>
			left.areaPath.join('/').localeCompare(right.areaPath.join('/')) ||
			(left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
			left.name.localeCompare(right.name),
	)
}

async function buildButtons(
	client: LeapClient,
	processorId: string,
	controlStations: Array<LutronControlStation>,
): Promise<Array<LutronButton>> {
	const buttons: Array<LutronButton> = []

	for (const station of controlStations) {
		for (const device of station.devices) {
			const deviceResponse = await client.read(device.href)
			assertSuccessfulResponse(deviceResponse, `${device.href} device read`)
			const deviceBody =
				(deviceResponse.Body?.['Device'] as Record<string, unknown> | undefined) ?? null
			if (!deviceBody) continue

			const buttonGroupResponse = await client.read(`${device.href}/buttongroup/expanded`)
			if (isNoContent(buttonGroupResponse)) continue
			assertSuccessfulResponse(
				buttonGroupResponse,
				`${device.href} button group expanded read`,
			)
			const groups =
				(buttonGroupResponse.Body?.['ButtonGroupsExpanded'] as Array<Record<string, unknown>> | undefined) ??
				[]

			for (const group of groups) {
				if (typeof group['href'] !== 'string') continue
				const entries = (group['Buttons'] as Array<Record<string, unknown>> | undefined) ?? []
				for (const button of entries) {
					if (typeof button['href'] !== 'string') continue
					const ledHref =
						typeof (button['AssociatedLED'] as Record<string, unknown> | undefined)?.['href'] ===
						'string'
							? ((button['AssociatedLED'] as Record<string, unknown>)['href'] as string)
							: null
					buttons.push({
						processorId,
						areaId: station.areaId,
						areaName: station.areaName,
						areaPath: station.areaPath,
						keypadDeviceId: device.deviceId,
						keypadHref: device.href,
						keypadName:
							typeof deviceBody['Name'] === 'string' ? deviceBody['Name'] : station.name,
						keypadModelNumber:
							typeof deviceBody['ModelNumber'] === 'string'
								? deviceBody['ModelNumber']
								: null,
						keypadSerialNumber:
							typeof deviceBody['SerialNumber'] === 'number'
								? String(deviceBody['SerialNumber'])
								: typeof deviceBody['SerialNumber'] === 'string'
									? deviceBody['SerialNumber']
									: null,
						buttonGroupId: extractResourceId(group['href']),
						buttonId: extractResourceId(button['href']),
						href: button['href'],
						buttonNumber:
							typeof button['ButtonNumber'] === 'number' ? button['ButtonNumber'] : 0,
						name:
							typeof button['Name'] === 'string'
								? button['Name']
								: extractResourceId(button['href']),
						label:
							typeof (button['Engraving'] as Record<string, unknown> | undefined)?.['Text'] ===
							'string'
								? (((button['Engraving'] as Record<string, unknown>)['Text'] as string)
										.replaceAll('\n', ' ')
										.trim() || (typeof button['Name'] === 'string' ? button['Name'] : extractResourceId(button['href'])))
								: typeof button['Name'] === 'string'
									? button['Name']
									: extractResourceId(button['href']),
						programmingModelType:
							typeof (button['ProgrammingModel'] as Record<string, unknown> | undefined)?.[
								'ProgrammingModelType'
							] === 'string'
								? ((button['ProgrammingModel'] as Record<string, unknown>)[
										'ProgrammingModelType'
									] as string)
								: null,
						ledId: ledHref ? extractResourceId(ledHref) : null,
						ledHref,
						ledState: await fetchLedState(client, ledHref),
					})
				}
			}
		}
	}

	return buttons.sort(
		(left, right) =>
			left.areaPath.join('/').localeCompare(right.areaPath.join('/')) ||
			left.keypadName.localeCompare(right.keypadName) ||
			left.buttonNumber - right.buttonNumber,
	)
}

async function buildVirtualButtons(
	client: LeapClient,
	processorId: string,
): Promise<Array<LutronVirtualButton>> {
	const response = await client.read('/virtualbutton')
	if (isNoContent(response)) return []
	assertSuccessfulResponse(response, 'virtual button read')
	const entries =
		(response.Body?.['VirtualButtons'] as Array<Record<string, unknown>> | undefined) ?? []
	return entries
		.filter((entry) => typeof entry['href'] === 'string')
		.map((entry) => ({
			processorId,
			virtualButtonId: extractResourceId(entry['href'] as string),
			href: entry['href'] as string,
			name:
				typeof entry['Name'] === 'string'
					? entry['Name']
					: extractResourceId(entry['href'] as string),
			isProgrammed: Boolean(entry['IsProgrammed']),
		}))
}

export async function loadLutronInventory(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
}): Promise<LutronInventory> {
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
		const areas = await buildAreaTree(client, input.processor.processorId)
		const zones = await buildZones(client, input.processor.processorId, areas)
		const controlStations = await buildControlStations(
			client,
			input.processor.processorId,
			areas,
		)
		const buttons = await buildButtons(client, input.processor.processorId, controlStations)
		const virtualButtons = await buildVirtualButtons(client, input.processor.processorId)
		return {
			processor: input.processor,
			areas,
			zones,
			controlStations,
			buttons,
			virtualButtons,
			sceneButtons: [
				...buttons.map((button) => ({ kind: 'keypad' as const, ...button })),
				...virtualButtons
					.filter((button) => button.isProgrammed)
					.map((button) => ({ kind: 'virtual' as const, ...button })),
			],
		}
	} finally {
		await client.close()
	}
}

export async function authenticateLutronProcessor(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
}) {
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
	} finally {
		await client.close()
	}
}

export async function pressLutronButton(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
	buttonId: string
}) {
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
		const response = await client.create(`/button/${input.buttonId}/commandprocessor`, {
			Command: {
				CommandType: 'PressAndRelease',
			},
		})
		assertSuccessfulResponse(response, `button ${input.buttonId} press`)
		return response
	} finally {
		await client.close()
	}
}

export async function setLutronZoneLevel(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
	zoneId: string
	level: number
}) {
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
		const response = await client.create(`/zone/${input.zoneId}/commandprocessor`, {
			Command: {
				CommandType: 'GoToLevel',
				Parameter: [
					{
						Type: 'Level',
						Value: input.level,
					},
				],
			},
		})
		assertSuccessfulResponse(response, `zone ${input.zoneId} level set`)
		return response
	} finally {
		await client.close()
	}
}
