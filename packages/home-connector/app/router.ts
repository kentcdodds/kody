import { createRouter } from 'remix/fetch-router'
import {
	createHomeDashboardHandler,
	createHealthHandler,
	createLutronSetupHandler,
	createLutronStatusHandler,
	createRokuSetupHandler,
	createRokuStatusHandler,
	createSamsungTvSetupHandler,
	createSamsungTvStatusHandler,
} from './handlers.ts'
import { routes } from './routes.ts'
import { type createLutronAdapter } from '../src/adapters/lutron/index.ts'
import { type createSamsungTvAdapter } from '../src/adapters/samsung-tv/index.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { type HomeConnectorState } from '../src/state.ts'

export function createHomeConnectorRouter(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	lutron: ReturnType<typeof createLutronAdapter>,
	samsungTv: ReturnType<typeof createSamsungTvAdapter>,
) {
	const router = createRouter({
		middleware: [],
	})

	router.map(routes.home, createHomeDashboardHandler(state, lutron, samsungTv))
	router.map(routes.health, createHealthHandler(state))
	router.map(routes.lutronStatus, createLutronStatusHandler(state, lutron))
	router.map(routes.lutronSetup, createLutronSetupHandler(state, lutron))
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
