import { http, HttpResponse } from 'msw'
import {
	getMockJellyfishDiscoveryPayload,
	resetMockJellyfishState,
} from '../src/adapters/jellyfish/mock-driver.ts'

export { resetMockJellyfishState }

const discoveryPattern = /^http:\/\/jellyfish\.mock\.local\/discovery\/?$/

export const jellyfishHandlers = [
	http.get(discoveryPattern, () => {
		return HttpResponse.json(getMockJellyfishDiscoveryPayload())
	}),
]
