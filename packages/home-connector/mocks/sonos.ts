import { http, HttpResponse } from 'msw'
import {
	listMockSonosPlayers,
	resetMockSonosState,
} from '../src/adapters/sonos/mock-driver.ts'

resetMockSonosState()

export const sonosHandlers = [
	http.get('http://sonos.mock.local/discovery', () => {
		return HttpResponse.json({
			players: listMockSonosPlayers(),
		})
	}),
]
