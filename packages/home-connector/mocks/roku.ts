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

function createRokuEcpHandlers(location: string) {
	const baseUrl = location.replace(/\/$/, '')
	return [
		http.post(
			`${baseUrl}/keypress/:key`,
			() => new HttpResponse(null, { status: 200 }),
		),
		http.post(
			`${baseUrl}/launch/:appId`,
			() => new HttpResponse(null, { status: 200 }),
		),
	]
}

export const rokuHandlers = [
	http.get('http://roku.mock.local/discovery', () => {
		return HttpResponse.json({
			devices: rokuDevices,
		})
	}),
	...rokuDevices.flatMap((device) => createRokuEcpHandlers(device.location)),
]
