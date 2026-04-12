import { http, HttpResponse } from 'msw'
import {
	applyMockVenstarControl,
	applyMockVenstarSettings,
	getMockVenstarInfo,
	getMockVenstarRuntimes,
	getMockVenstarSensors,
	resetMockVenstarState,
} from '../src/adapters/venstar/mock-driver.ts'

export { resetMockVenstarState }

resetMockVenstarState()

function resolveIpFromUrl(url: URL) {
	return url.hostname
}

const infoPattern = /^http:\/\/[^/]+\/query\/info\/?$/
const sensorsPattern = /^http:\/\/[^/]+\/query\/sensors\/?$/
const runtimesPattern = /^http:\/\/[^/]+\/query\/runtimes\/?$/
const controlPattern = /^http:\/\/[^/]+\/control\/?$/
const settingsPattern = /^http:\/\/[^/]+\/settings\/?$/

export const venstarHandlers = [
	http.get(infoPattern, ({ request }) => {
		const ip = resolveIpFromUrl(new URL(request.url))
		return HttpResponse.json(getMockVenstarInfo(ip))
	}),
	http.get(sensorsPattern, ({ request }) => {
		const ip = resolveIpFromUrl(new URL(request.url))
		return HttpResponse.json(getMockVenstarSensors(ip))
	}),
	http.get(runtimesPattern, ({ request }) => {
		const ip = resolveIpFromUrl(new URL(request.url))
		return HttpResponse.json(getMockVenstarRuntimes(ip))
	}),
	http.post(controlPattern, async ({ request }) => {
		const ip = resolveIpFromUrl(new URL(request.url))
		const body = await request.text()
		const params = new URLSearchParams(body)
		const payload = {
			...(params.has('mode') ? { mode: Number(params.get('mode')) } : {}),
			...(params.has('fan') ? { fan: Number(params.get('fan')) } : {}),
			...(params.has('heattemp')
				? { heattemp: Number(params.get('heattemp')) }
				: {}),
			...(params.has('cooltemp')
				? { cooltemp: Number(params.get('cooltemp')) }
				: {}),
		}
		return HttpResponse.json(applyMockVenstarControl(ip, payload))
	}),
	http.post(settingsPattern, async ({ request }) => {
		const ip = resolveIpFromUrl(new URL(request.url))
		const body = await request.text()
		const params = new URLSearchParams(body)
		const payload = {
			...(params.has('away') ? { away: Number(params.get('away')) } : {}),
			...(params.has('schedule')
				? { schedule: Number(params.get('schedule')) }
				: {}),
			...(params.has('hum')
				? { humidify: Number(params.get('hum')) }
				: {}),
			...(params.has('dehum')
				? { dehumidify: Number(params.get('dehum')) }
				: {}),
			...(params.has('tempunits')
				? { tempunits: Number(params.get('tempunits')) }
				: {}),
		}
		return HttpResponse.json(applyMockVenstarSettings(ip, payload))
	}),
]
