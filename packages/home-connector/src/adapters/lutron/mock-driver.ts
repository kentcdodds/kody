import {
	cloneMockAreas,
	cloneMockButtons,
	cloneMockControlStations,
	cloneMockProcessors,
	cloneMockVirtualButtons,
	cloneMockZones,
	mockLutronCredentials,
} from './fixtures.ts'
import {
	type LutronArea,
	type LutronButton,
	type LutronControlStation,
	type LutronPersistedProcessor,
	type LutronVirtualButton,
	type LutronZone,
	type LutronZoneStatus,
} from './types.ts'

type MockLutronSystem = {
	processors: Array<LutronPersistedProcessor>
	areas: Array<LutronArea>
	zones: Array<LutronZone>
	controlStations: Array<LutronControlStation>
	buttons: Array<LutronButton>
	virtualButtons: Array<LutronVirtualButton>
}

let mockLutronSystem: MockLutronSystem = {
	processors: cloneMockProcessors(),
	areas: cloneMockAreas(),
	zones: cloneMockZones(),
	controlStations: cloneMockControlStations(),
	buttons: cloneMockButtons(),
	virtualButtons: cloneMockVirtualButtons(),
}

function findMockProcessorByHost(host: string) {
	return (
		mockLutronSystem.processors.find((processor) => processor.host === host) ??
		null
	)
}

function requireMockProcessorByHost(host: string) {
	const processor = findMockProcessorByHost(host)
	if (!processor) {
		throw new Error(`Unknown mock Lutron processor host "${host}".`)
	}
	return processor
}

function requireMockButton(buttonId: string) {
	const button =
		mockLutronSystem.buttons.find(
			(candidate) => candidate.buttonId === buttonId,
		) ?? null
	if (!button) {
		throw new Error(`Unknown mock Lutron button "${buttonId}".`)
	}
	return button
}

function requireMockZone(zoneId: string) {
	const zone =
		mockLutronSystem.zones.find((candidate) => candidate.zoneId === zoneId) ??
		null
	if (!zone) {
		throw new Error(`Unknown mock Lutron zone "${zoneId}".`)
	}
	return zone
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

function setButtonLedState(buttonId: string, state: 'On' | 'Off') {
	const button = requireMockButton(buttonId)
	button.ledState = state
}

function setZoneStatus(zoneId: string, status: LutronZoneStatus) {
	requireMockZone(zoneId).status = status
}

function applyMockSceneButton(buttonId: string) {
	switch (buttonId) {
		case '329':
			setButtonLedState('329', 'On')
			setButtonLedState('333', 'Off')
			setZoneStatus(
				'495',
				createSpectrumStatus({
					level: 100,
					vibrancy: 20,
					hue: 35,
					saturation: 10,
					kelvin: 3500,
				}),
			)
			setZoneStatus(
				'512',
				createSpectrumStatus({
					level: 100,
					vibrancy: 20,
					hue: 35,
					saturation: 10,
					kelvin: 3500,
				}),
			)
			setZoneStatus('595', createDimmedStatus(100))
			setZoneStatus('611', createDimmedStatus(0))
			setZoneStatus('755', createSwitchedStatus(false))
			return
		case '333':
			setButtonLedState('329', 'Off')
			setButtonLedState('333', 'On')
			setZoneStatus(
				'495',
				createSpectrumStatus({
					level: 80,
					vibrancy: 100,
					hue: 40,
					saturation: 50,
					kelvin: 4000,
				}),
			)
			setZoneStatus(
				'512',
				createSpectrumStatus({
					level: 80,
					vibrancy: 100,
					hue: 40,
					saturation: 50,
					kelvin: 4000,
				}),
			)
			setZoneStatus('595', createDimmedStatus(0))
			setZoneStatus('611', createDimmedStatus(100))
			setZoneStatus('755', createSwitchedStatus(true))
			return
		case '369':
			setButtonLedState('329', 'Off')
			setButtonLedState('333', 'Off')
			setZoneStatus(
				'495',
				createSpectrumStatus({
					level: 0,
					vibrancy: 35,
					hue: 40,
					saturation: 16,
					kelvin: 4000,
				}),
			)
			setZoneStatus(
				'512',
				createSpectrumStatus({
					level: 0,
					vibrancy: 35,
					hue: 40,
					saturation: 16,
					kelvin: 4000,
				}),
			)
			setZoneStatus('595', createDimmedStatus(0))
			setZoneStatus('611', createDimmedStatus(0))
			setZoneStatus('755', createSwitchedStatus(false))
			return
		default:
			return
	}
}

export function resetMockLutronSystem() {
	mockLutronSystem = {
		processors: cloneMockProcessors(),
		areas: cloneMockAreas(),
		zones: cloneMockZones(),
		controlStations: cloneMockControlStations(),
		buttons: cloneMockButtons(),
		virtualButtons: cloneMockVirtualButtons(),
	}
}

export function listMockLutronProcessors() {
	return structuredClone(mockLutronSystem.processors)
}

export function validateMockLutronCredentials(
	host: string,
	username: string,
	password: string,
) {
	const processor = requireMockProcessorByHost(host)
	return (
		processor.username === username &&
		processor.password === password &&
		username === mockLutronCredentials.username &&
		password === mockLutronCredentials.password
	)
}

export function listMockLutronAreas(processorId: string) {
	return structuredClone(
		mockLutronSystem.areas.filter((area) => area.processorId === processorId),
	)
}

export function listMockLutronZones(processorId: string, areaId: string) {
	return structuredClone(
		mockLutronSystem.zones.filter(
			(zone) => zone.processorId === processorId && zone.areaId === areaId,
		),
	)
}

export function listMockLutronControlStations(
	processorId: string,
	areaId: string,
) {
	return structuredClone(
		mockLutronSystem.controlStations.filter(
			(station) =>
				station.processorId === processorId && station.areaId === areaId,
		),
	)
}

export function listMockLutronButtonsForDevice(deviceId: string) {
	return structuredClone(
		mockLutronSystem.buttons.filter(
			(button) => button.keypadDeviceId === deviceId,
		),
	)
}

export function listMockLutronVirtualButtons(processorId: string) {
	return structuredClone(
		mockLutronSystem.virtualButtons.filter(
			(button) => button.processorId === processorId,
		),
	)
}

export function getMockLutronButton(buttonId: string) {
	return structuredClone(requireMockButton(buttonId))
}

export function getMockLutronZone(zoneId: string) {
	return structuredClone(requireMockZone(zoneId))
}

export function pressMockLutronButton(buttonId: string) {
	requireMockButton(buttonId)
	applyMockSceneButton(buttonId)
	return {
		ok: true,
		buttonId,
	}
}

export function setMockLutronZoneLevel(zoneId: string, level: number) {
	const zone = requireMockZone(zoneId)
	if (zone.controlType === 'Switched') {
		zone.status = createSwitchedStatus(level > 0)
	} else if (zone.controlType === 'Dimmed') {
		zone.status = createDimmedStatus(level)
	} else {
		zone.status = {
			...(zone.status ?? createDimmedStatus(level)),
			level,
		}
	}
	return {
		ok: true,
		zoneId,
		level,
	}
}
