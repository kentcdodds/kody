import { createRouter } from 'remix/fetch-router'
import {
	createHealthHandler,
	createRokuSetupHandler,
	createRokuStatusHandler,
} from './handlers.ts'
import { routes } from './routes.ts'
import { type HomeConnectorState } from '../src/state.ts'

export function createHomeConnectorRouter(state: HomeConnectorState) {
	const router = createRouter({
		middleware: [],
	})

	router.map(routes.health, createHealthHandler(state))
	router.map(routes.rokuStatus, createRokuStatusHandler(state))
	router.map(routes.rokuSetup, createRokuSetupHandler(state))

	return router
}
