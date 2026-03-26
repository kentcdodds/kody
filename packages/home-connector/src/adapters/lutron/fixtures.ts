import {
	type LutronArea,
	type LutronButton,
	type LutronControlStation,
	type LutronPersistedProcessor,
	type LutronVirtualButton,
	type LutronZone,
	type LutronZoneStatus,
} from './types.ts'

// Authoritative references used to shape these sanitized example fixtures:
// - LEAP overview:
//   https://support.lutron.com/us/en/product/homeworks/article/networking/Lutron-s-LEAP-API-Integration-Protocol
// - QSX secure comms note for 8902:
//   https://support.lutron.com/us/en/product/homeworks/article/networking/Why-upgrading-Lutron-Designer-is-required-for-enhanced-communications-to-the-processor
//
// The values below are intentionally generic and do not mirror a specific live
// installation. They are derived from the endpoint families and payload shapes
// observed against a real QSX processor, but the names and scene layout are
// sanitized for portable mocking and tests.

export const lutronFixtureReferenceUrls = {
	leapOverview:
		'https://support.lutron.com/us/en/product/homeworks/article/networking/Lutron-s-LEAP-API-Integration-Protocol',
	qsxSecureComms:
		'https://support.lutron.com/us/en/product/homeworks/article/networking/Why-upgrading-Lutron-Designer-is-required-for-enhanced-communications-to-the-processor',
} as const

export const mockLutronCredentials = {
	username: 'mock-lutron-user',
	password: 'mock-lutron-pass',
} as const

export const mockLutronProcessors: Array<LutronPersistedProcessor> = [
	{
		processorId: 'lutron-qsx-main',
		instanceName: 'Lutron Status',
		name: 'Primary Processor',
		host: 'lutron-main.mock.local',
		discoveryPort: 22,
		leapPort: 8081,
		address: '192.168.50.10',
		serialNumber: 'ABC12345',
		macAddress: 'AA:BB:CC:DD:EE:01',
		systemType: 'HWQSProcessor',
		codeVersion: '26.00.14f000',
		deviceClass: '08180101',
		claimStatus: 'Claimed',
		networkStatus: 'InternetWorking',
		firmwareStatus: '1:NoUpdate',
		status: 'good',
		lastSeenAt: '2026-03-25T17:00:00.000Z',
		rawDiscovery: {
			txt: {
				MACADDR: 'AA:BB:CC:DD:EE:01',
				CODEVER: '26.00.14f000',
				SYSTYPE: 'HWQSProcessor',
				CLAIM_STATUS: 'Claimed',
			},
		},
		username: mockLutronCredentials.username,
		password: mockLutronCredentials.password,
		lastAuthenticatedAt: null,
		lastAuthError: null,
	},
	{
		processorId: 'lutron-qsx-wireless',
		instanceName: 'Lutron Status (2)',
		name: 'Wireless Processor',
		host: 'lutron-wireless.mock.local',
		discoveryPort: 22,
		leapPort: 8081,
		address: '192.168.50.11',
		serialNumber: 'XYZ98765',
		macAddress: 'AA:BB:CC:DD:EE:02',
		systemType: 'HWQSProcessor',
		codeVersion: '26.00.14f000',
		deviceClass: '08110201',
		claimStatus: 'Claimed',
		networkStatus: 'InternetWorking',
		firmwareStatus: '1:NoUpdate',
		status: 'good',
		lastSeenAt: '2026-03-25T17:00:00.000Z',
		rawDiscovery: {
			txt: {
				MACADDR: 'AA:BB:CC:DD:EE:02',
				CODEVER: '26.00.14f000',
				SYSTYPE: 'HWQSProcessor',
				CLAIM_STATUS: 'Claimed',
			},
		},
		username: null,
		password: null,
		lastAuthenticatedAt: null,
		lastAuthError: null,
	},
]

const initialMockAreas: Array<LutronArea> = [
	{
		processorId: 'lutron-qsx-main',
		areaId: '3',
		href: '/area/3',
		name: 'House',
		parentHref: null,
		parentAreaId: null,
		isLeaf: false,
		path: ['House'],
	},
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		href: '/area/32',
		name: 'Studio',
		parentHref: '/area/3',
		parentAreaId: '3',
		isLeaf: true,
		path: ['House', 'Studio'],
	},
]

function createSpectrumStatus(input: {
	level: number
	vibrancy: number
	hue: number
	saturation: number
	kelvin: number
}): LutronZoneStatus {
	return {
		level: input.level,
		switchedLevel: null,
		vibrancy: input.vibrancy,
		whiteTuningKelvin: input.kelvin,
		hue: input.hue,
		saturation: input.saturation,
		statusAccuracy: 'Good',
		zoneLockState: null,
	}
}

function createDimmedStatus(level: number): LutronZoneStatus {
	return {
		level,
		switchedLevel: null,
		vibrancy: null,
		whiteTuningKelvin: null,
		hue: null,
		saturation: null,
		statusAccuracy: 'Good',
		zoneLockState: 'Unlocked',
	}
}

function createSwitchedStatus(isOn: boolean): LutronZoneStatus {
	return {
		level: isOn ? 100 : 0,
		switchedLevel: isOn ? 'On' : 'Off',
		vibrancy: null,
		whiteTuningKelvin: null,
		hue: null,
		saturation: null,
		statusAccuracy: 'Good',
		zoneLockState: 'Unlocked',
	}
}

const initialMockZones: Array<LutronZone> = [
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		areaName: 'Studio',
		areaPath: ['House', 'Studio'],
		zoneId: '495',
		href: '/zone/495',
		name: 'Key Light',
		controlType: 'SpectrumTune',
		categoryType: null,
		isLight: true,
		availableControlTypes: [
			'Dimmed',
			'WhiteTune',
			'WarmDim',
			'ColorTune',
			'Vibrancy',
		],
		sortOrder: 0,
		status: createSpectrumStatus({
			level: 100,
			vibrancy: 35,
			hue: 40,
			saturation: 16,
			kelvin: 4000,
		}),
	},
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		areaName: 'Studio',
		areaPath: ['House', 'Studio'],
		zoneId: '512',
		href: '/zone/512',
		name: 'Fill Light',
		controlType: 'SpectrumTune',
		categoryType: null,
		isLight: true,
		availableControlTypes: [
			'Dimmed',
			'WhiteTune',
			'WarmDim',
			'ColorTune',
			'Vibrancy',
		],
		sortOrder: 1,
		status: createSpectrumStatus({
			level: 100,
			vibrancy: 35,
			hue: 40,
			saturation: 16,
			kelvin: 4000,
		}),
	},
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		areaName: 'Studio',
		areaPath: ['House', 'Studio'],
		zoneId: '595',
		href: '/zone/595',
		name: 'General Recessed',
		controlType: 'Dimmed',
		categoryType: null,
		isLight: true,
		availableControlTypes: ['Dimmed'],
		sortOrder: 2,
		status: createDimmedStatus(25),
	},
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		areaName: 'Studio',
		areaPath: ['House', 'Studio'],
		zoneId: '611',
		href: '/zone/611',
		name: 'On Air',
		controlType: 'Dimmed',
		categoryType: null,
		isLight: true,
		availableControlTypes: ['Dimmed'],
		sortOrder: 3,
		status: createDimmedStatus(100),
	},
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		areaName: 'Studio',
		areaPath: ['House', 'Studio'],
		zoneId: '755',
		href: '/zone/755',
		name: 'Practical Outlets',
		controlType: 'Switched',
		categoryType: 'OtherAmbient',
		isLight: true,
		availableControlTypes: [],
		sortOrder: 4,
		status: createSwitchedStatus(true),
	},
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		areaName: 'Studio',
		areaPath: ['House', 'Studio'],
		zoneId: '858',
		href: '/zone/858',
		name: 'Shade Group',
		controlType: 'Shade',
		categoryType: null,
		isLight: false,
		availableControlTypes: [],
		sortOrder: 5,
		status: {
			level: 100,
			switchedLevel: null,
			vibrancy: null,
			whiteTuningKelvin: null,
			hue: null,
			saturation: null,
			statusAccuracy: 'Good',
			zoneLockState: null,
		},
	},
]

const initialMockControlStations: Array<LutronControlStation> = [
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		areaName: 'Studio',
		areaPath: ['House', 'Studio'],
		controlStationId: '318',
		href: '/controlstation/318',
		name: 'Entry Keypad',
		sortOrder: 0,
		devices: [
			{
				deviceId: '320',
				href: '/device/320',
				deviceType: 'PalladiomKeypad',
				addressedState: 'Addressed',
				gangPosition: 0,
			},
		],
	},
]

const initialMockButtons: Array<LutronButton> = [
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		areaName: 'Studio',
		areaPath: ['House', 'Studio'],
		keypadDeviceId: '320',
		keypadHref: '/device/320',
		keypadName: 'Entry Keypad',
		keypadModelNumber: 'HQWT-U-P4W',
		keypadSerialNumber: '137522215',
		buttonGroupId: '367',
		buttonId: '329',
		href: '/button/329',
		buttonNumber: 1,
		name: 'Button 1',
		label: 'Work',
		programmingModelType: 'SingleActionProgrammingModel',
		ledId: '325',
		ledHref: '/led/325',
		ledState: 'Off',
	},
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		areaName: 'Studio',
		areaPath: ['House', 'Studio'],
		keypadDeviceId: '320',
		keypadHref: '/device/320',
		keypadName: 'Entry Keypad',
		keypadModelNumber: 'HQWT-U-P4W',
		keypadSerialNumber: '137522215',
		buttonGroupId: '367',
		buttonId: '333',
		href: '/button/333',
		buttonNumber: 2,
		name: 'Button 2',
		label: 'Live',
		programmingModelType: 'SingleActionProgrammingModel',
		ledId: '326',
		ledHref: '/led/326',
		ledState: 'On',
	},
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		areaName: 'Studio',
		areaPath: ['House', 'Studio'],
		keypadDeviceId: '320',
		keypadHref: '/device/320',
		keypadName: 'Entry Keypad',
		keypadModelNumber: 'HQWT-U-P4W',
		keypadSerialNumber: '137522215',
		buttonGroupId: '367',
		buttonId: '337',
		href: '/button/337',
		buttonNumber: 3,
		name: 'Button 3',
		label: 'Shade',
		programmingModelType: 'AdvancedToggleProgrammingModel',
		ledId: '327',
		ledHref: '/led/327',
		ledState: 'Off',
	},
	{
		processorId: 'lutron-qsx-main',
		areaId: '32',
		areaName: 'Studio',
		areaPath: ['House', 'Studio'],
		keypadDeviceId: '320',
		keypadHref: '/device/320',
		keypadName: 'Entry Keypad',
		keypadModelNumber: 'HQWT-U-P4W',
		keypadSerialNumber: '137522215',
		buttonGroupId: '367',
		buttonId: '369',
		href: '/button/369',
		buttonNumber: 4,
		name: 'Button 4',
		label: 'Off',
		programmingModelType: 'SingleActionProgrammingModel',
		ledId: '368',
		ledHref: '/led/368',
		ledState: 'Off',
	},
]

const initialMockVirtualButtons: Array<LutronVirtualButton> = []

export const lutronExampleResponses = {
	login: {
		CommuniqueType: 'UpdateResponse',
		Header: {
			MessageBodyType: 'OneLoginDefinition',
			StatusCode: '200 OK',
			Url: '/login',
		},
		Body: {
			Login: {
				href: '/login',
				ContextType: 'Application',
				LoginId: mockLutronCredentials.username,
			},
		},
	},
	ping: {
		CommuniqueType: 'ReadResponse',
		Header: {
			MessageBodyType: 'OnePingResponse',
			StatusCode: '200 OK',
			Url: '/server/status/ping',
		},
		Body: {
			PingResponse: {
				LEAPVersion: 3.247,
			},
		},
	},
	rootArea: {
		CommuniqueType: 'ReadResponse',
		Header: {
			MessageBodyType: 'OneAreaDefinition',
			StatusCode: '200 OK',
			Url: '/area/rootarea',
		},
		Body: {
			Area: {
				href: '/area/3',
				Name: 'House',
				IsLeaf: false,
			},
		},
	},
} as const

export function cloneMockProcessors() {
	return structuredClone(mockLutronProcessors)
}

export function cloneMockAreas() {
	return structuredClone(initialMockAreas)
}

export function cloneMockZones() {
	return structuredClone(initialMockZones)
}

export function cloneMockControlStations() {
	return structuredClone(initialMockControlStations)
}

export function cloneMockButtons() {
	return structuredClone(initialMockButtons)
}

export function cloneMockVirtualButtons() {
	return structuredClone(initialMockVirtualButtons)
}
