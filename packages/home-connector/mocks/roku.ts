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
		http.get(`${baseUrl}/query/apps`, () => {
			return HttpResponse.xml(
				`<?xml version="1.0" encoding="UTF-8"?>
<apps>
	<app id="837" type="appl" version="5.7.0">YouTube</app>
	<app id="13842" type="appl" version="2.0.1">Jellyfin</app>
</apps>`,
				{ status: 200 },
			)
		}),
		http.get(`${baseUrl}/query/active-app`, () => {
			return HttpResponse.xml(
				`<?xml version="1.0" encoding="UTF-8"?>
<active-app>
	<app id="13842" type="appl" version="2.0.1">Jellyfin</app>
</active-app>`,
				{ status: 200 },
			)
		}),
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
