import { http, HttpResponse } from 'msw'

const rokuDevices = [
	{
		id: 'roku-living-room',
		name: 'Living Room Roku',
		location: 'http://192.168.1.45:8060/',
		lastSeenAt: '2026-03-24T12:00:00.000Z',
		adopted: true,
		controlEnabled: true,
	},
	{
		id: 'roku-bedroom',
		name: 'Bedroom Roku',
		location: 'http://192.168.1.46:8060/',
		lastSeenAt: '2026-03-24T12:00:00.000Z',
		adopted: false,
		controlEnabled: false,
	},
] as const

export const rokuHandlers = [
	http.get('http://roku.mock.local/discovery', () => {
		return HttpResponse.json({
			devices: rokuDevices,
		})
	}),
	http.post(
		'http://roku.mock.local/control/:deviceId/:action',
		async ({ params }) => {
			return HttpResponse.json({
				ok: true,
				deviceId: params['deviceId'],
				action: params['action'],
			})
		},
	),
]
