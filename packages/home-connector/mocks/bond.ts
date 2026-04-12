import { http, HttpResponse } from 'msw'

const mockVersion = {
	target: 'mock-bond',
	fw_ver: 'v0.0.1-mock',
	model: 'BD-MOCK',
	bondid: 'MOCKBOND1',
	api: 2,
	_: 'mock',
}

const mockDevices: Record<
	string,
	{
		name: string
		type: string
		location: string
		template: string
		subtype: string
		actions: Array<string>
	}
> = {
	mockdev1: {
		name: 'Mock Office Sheer',
		type: 'MS',
		location: 'Office',
		template: 'RMS35',
		subtype: 'ROLLER_SHADE',
		actions: ['Open', 'Close', 'Stop', 'SetPosition', 'Hold', 'ToggleOpen'],
	},
}

let mockDeviceState: Record<string, Record<string, unknown>> = {
	mockdev1: { open: 0, position: 100 },
}

const mockGroups: Record<
	string,
	{ name: string; devices: Array<string>; actions: Array<string> }
> = {
	mockgrp1: {
		name: 'Mock Office Group',
		devices: ['mockdev1'],
		actions: ['Open', 'Close', 'Stop', 'SetPosition'],
	},
}

let mockGroupState: Record<string, Record<string, unknown>> = {
	mockgrp1: { open: 0 },
}

export function resetMockBondState() {
	mockDeviceState = {
		mockdev1: { open: 0, position: 100 },
	}
	mockGroupState = {
		mockgrp1: { open: 0 },
	}
}

resetMockBondState()

export const bondHandlers = [
	http.get('http://bond.mock.local/discovery', () => {
		return HttpResponse.json({
			bridges: [
				{
					bondid: 'MOCKBOND1',
					instanceName: 'MOCKBOND1',
					host: 'bond.mock.local',
					port: 80,
					address: '127.0.0.1',
					model: 'BD-MOCK',
					fwVer: 'v0.0.1-mock',
				},
			],
		})
	}),

	http.get('http://bond.mock.local/v2/sys/version', () => {
		return HttpResponse.json(mockVersion)
	}),

	http.get('http://bond.mock.local/v2/token', () => {
		return HttpResponse.json({
			locked: 0,
			token: 'mock-bond-token',
			pin_attempts_left: 10,
			_: 't',
		})
	}),

	http.get('http://bond.mock.local/v2/devices', () => {
		const payload: Record<string, unknown> = {}
		for (const id of Object.keys(mockDevices)) {
			payload[id] = { _: id }
		}
		return HttpResponse.json(payload)
	}),

	http.get('http://bond.mock.local/v2/devices/:deviceId', ({ params }) => {
		const deviceId = String(params.deviceId ?? '')
		const meta = mockDevices[deviceId]
		if (!meta) {
			return HttpResponse.json({ message: 'not found' }, { status: 404 })
		}
		return HttpResponse.json({
			...meta,
			_: deviceId,
		})
	}),

	http.get(
		'http://bond.mock.local/v2/devices/:deviceId/state',
		({ params }) => {
			const deviceId = String(params.deviceId ?? '')
			const state = mockDeviceState[deviceId]
			if (!state) {
				return HttpResponse.json({ message: 'not found' }, { status: 404 })
			}
			return HttpResponse.json({ ...state, _: 's' })
		},
	),

	http.put(
		'http://bond.mock.local/v2/devices/:deviceId/actions/:action',
		async ({ params, request }) => {
			const deviceId = String(params.deviceId ?? '')
			const action = String(params.action ?? '')
			if (!mockDevices[deviceId]) {
				return HttpResponse.json({ message: 'not found' }, { status: 404 })
			}
			let argument: unknown
			try {
				const body = (await request.json()) as Record<string, unknown>
				argument = body['argument']
			} catch {
				argument = undefined
			}
			const state = { ...(mockDeviceState[deviceId] ?? {}) }
			if (action === 'Open') {
				state['open'] = 1
				state['position'] = 0
			} else if (action === 'Close') {
				state['open'] = 0
				state['position'] = 100
			} else if (action === 'SetPosition' && typeof argument === 'number') {
				state['position'] = argument
				state['open'] = argument > 0 && argument < 100 ? 1 : 0
			} else if (action === 'Stop') {
				state['open'] = state['open'] ?? 0
			}
			mockDeviceState[deviceId] = state
			return HttpResponse.json({ argument, _: '0' })
		},
	),

	http.get('http://bond.mock.local/v2/groups', () => {
		const payload: Record<string, unknown> = {}
		for (const id of Object.keys(mockGroups)) {
			payload[id] = { _: id }
		}
		return HttpResponse.json(payload)
	}),

	http.get('http://bond.mock.local/v2/groups/:groupId', ({ params }) => {
		const groupId = String(params.groupId ?? '')
		const meta = mockGroups[groupId]
		if (!meta) {
			return HttpResponse.json({ message: 'not found' }, { status: 404 })
		}
		return HttpResponse.json({ ...meta, _: groupId })
	}),

	http.get('http://bond.mock.local/v2/groups/:groupId/state', ({ params }) => {
		const groupId = String(params.groupId ?? '')
		const state = mockGroupState[groupId]
		if (!state) {
			return HttpResponse.json({ message: 'not found' }, { status: 404 })
		}
		return HttpResponse.json({ ...state, _: 'g' })
	}),

	http.put(
		'http://bond.mock.local/v2/groups/:groupId/actions/:action',
		async ({ params, request }) => {
			const groupId = String(params.groupId ?? '')
			const action = String(params.action ?? '')
			if (!mockGroups[groupId]) {
				return HttpResponse.json({ message: 'not found' }, { status: 404 })
			}
			let argument: unknown
			try {
				const body = (await request.json()) as Record<string, unknown>
				argument = body['argument']
			} catch {
				argument = undefined
			}
			const state = { ...(mockGroupState[groupId] ?? {}) }
			if (action === 'Open') state['open'] = 1
			if (action === 'Close') state['open'] = 0
			if (action === 'SetPosition' && typeof argument === 'number') {
				state['position'] = argument
			}
			mockGroupState[groupId] = state
			return HttpResponse.json({ argument, _: '0' })
		},
	),
]
