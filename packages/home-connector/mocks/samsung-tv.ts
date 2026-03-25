import { http, HttpResponse } from 'msw'
import {
	getMockSamsungAppStatus,
	getMockSamsungDeviceInfo,
	launchMockSamsungApp,
	listMockSamsungDevices,
	resetMockSamsungDevices,
} from '../src/adapters/samsung-tv/mock-driver.ts'

resetMockSamsungDevices()

const samsungTvDevices = listMockSamsungDevices()

function createSamsungTvHandlers(host: string) {
	return [
		http.get(`http://${host}:8001/api/v2/`, () => {
			return HttpResponse.json(getMockSamsungDeviceInfo(host))
		}),
		http.get(`http://${host}:8001/api/v2/applications/:appId`, ({ params }) => {
			const appId = String(params['appId'] ?? '')
			const status = getMockSamsungAppStatus(host, appId)
			if (!status) {
				return HttpResponse.json(
					{
						code: 404,
						message: 'Not found error.',
						status: 404,
					},
					{
						status: 404,
					},
				)
			}
			return HttpResponse.json(status)
		}),
		http.post(
			`http://${host}:8001/api/v2/applications/:appId`,
			({ params }) => {
				const appId = String(params['appId'] ?? '')
				try {
					return HttpResponse.json(launchMockSamsungApp(host, appId))
				} catch (error) {
					return HttpResponse.json(
						{
							error: error instanceof Error ? error.message : String(error),
						},
						{
							status: 404,
						},
					)
				}
			},
		),
	]
}

export const samsungTvHandlers = [
	http.get('http://samsung-tv.mock.local/discovery', () => {
		return HttpResponse.json({
			devices: listMockSamsungDevices(),
		})
	}),
	...samsungTvDevices.flatMap((device) => createSamsungTvHandlers(device.host)),
]
