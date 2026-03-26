import { http, HttpResponse } from 'msw'
import {
	listMockLutronProcessors,
	resetMockLutronSystem,
} from '../src/adapters/lutron/mock-driver.ts'

resetMockLutronSystem()

export const lutronHandlers = [
	http.get('http://lutron.mock.local/discovery', () => {
		return HttpResponse.json({
			processors: listMockLutronProcessors(),
		})
	}),
]
