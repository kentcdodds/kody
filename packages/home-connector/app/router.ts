import { createRouter } from 'remix/fetch-router'
import {
	createHomeDashboardHandler,
	createHealthHandler,
	createRokuSetupHandler,
	createRokuStatusHandler,
	createSamsungTvSetupHandler,
	createSamsungTvStatusHandler,
} from './handlers.ts'
import { routes } from './routes.ts'
import { type createSamsungTvAdapter } from '../src/adapters/samsung-tv/index.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { type HomeConnectorState } from '../src/state.ts'

export function createHomeConnectorRouter(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	samsungTv: ReturnType<typeof createSamsungTvAdapter>,
) {
	const router = createRouter({
		middleware: [],
	})

	router.map(routes.home, createHomeDashboardHandler(state, samsungTv))
	router.map(routes.health, createHealthHandler(state))
	router.map(routes.rokuStatus, createRokuStatusHandler(state, config))
	router.map(routes.rokuSetup, createRokuSetupHandler(state))
	router.map(
		routes.samsungTvStatus,
		createSamsungTvStatusHandler(state, samsungTv),
	)
	router.map(
		routes.samsungTvSetup,
		createSamsungTvSetupHandler(state, samsungTv),
	)

	return router
}
