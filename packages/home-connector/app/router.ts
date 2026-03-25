import { createRouter } from 'remix/fetch-router'
import {
	createHomeDashboardHandler,
	createHealthHandler,
	createSentryTestHandler,
	createRokuSetupHandler,
	createRokuStatusHandler,
} from './handlers.ts'
import { routes } from './routes.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { type HomeConnectorState } from '../src/state.ts'

export function createHomeConnectorRouter(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	const router = createRouter({
		middleware: [],
	})

	router.map(routes.home, createHomeDashboardHandler(state))
	router.map(routes.health, createHealthHandler(state))
	router.map(routes.sentryTest, createSentryTestHandler())
	router.map(routes.rokuStatus, createRokuStatusHandler(state, config))
	router.map(routes.rokuSetup, createRokuSetupHandler(state))

	return router
}
