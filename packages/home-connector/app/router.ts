import { createRouter } from 'remix/fetch-router'
import {
	createHealthHandler,
	createLutronSetupHandler,
	createLutronStatusHandler,
	createRokuSetupHandler,
	createRokuStatusHandler,
	createSamsungTvSetupHandler,
	createSamsungTvStatusHandler,
} from './handlers.ts'
import {
	createDashboardHandler,
	createDiagnosticsHandler,
	createIslandRouterStatusHandler,
	createSystemStatusHandler,
} from './dashboard-handlers.ts'
import {
	createBondSetupHandler,
	createBondStatusHandler,
} from './bond-handlers.ts'
import {
	createJellyfishSetupHandler,
	createJellyfishStatusHandler,
} from './jellyfish-handlers.ts'
import {
	createSonosSetupHandler,
	createSonosStatusHandler,
} from './sonos-handlers.ts'
import {
	createVenstarSetupHandler,
	createVenstarStatusHandler,
} from './venstar-handlers.ts'
import { routes } from './routes.ts'
import { type createLutronAdapter } from '../src/adapters/lutron/index.ts'
import { type createBondAdapter } from '../src/adapters/bond/index.ts'
import { type createJellyfishAdapter } from '../src/adapters/jellyfish/index.ts'
import { type createSonosAdapter } from '../src/adapters/sonos/index.ts'
import { type createSamsungTvAdapter } from '../src/adapters/samsung-tv/index.ts'
import { type createVenstarAdapter } from '../src/adapters/venstar/index.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { type HomeConnectorState } from '../src/state.ts'
import { type createIslandRouterAdapter } from '../src/adapters/island-router/index.ts'

export function createHomeConnectorRouter(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	lutron: ReturnType<typeof createLutronAdapter>,
	samsungTv: ReturnType<typeof createSamsungTvAdapter>,
	sonos: ReturnType<typeof createSonosAdapter>,
	bond: ReturnType<typeof createBondAdapter>,
	islandRouter: ReturnType<typeof createIslandRouterAdapter>,
	jellyfish: ReturnType<typeof createJellyfishAdapter>,
	venstar: ReturnType<typeof createVenstarAdapter>,
) {
	const router = createRouter({
		middleware: [],
	})

	router.map(routes, {
		actions: {
			home: createDashboardHandler({
				state,
				config,
				lutron,
				samsungTv,
				sonos,
				bond,
				islandRouter,
				jellyfish,
				venstar,
			}),
			systemStatus: createSystemStatusHandler({
				state,
				config,
				lutron,
				samsungTv,
				sonos,
				bond,
				islandRouter,
				jellyfish,
				venstar,
			}),
			diagnostics: createDiagnosticsHandler({
				state,
				config,
				lutron,
				samsungTv,
				sonos,
				bond,
				islandRouter,
				jellyfish,
				venstar,
			}),
			islandRouterStatus: createIslandRouterStatusHandler({
				state,
				config,
				lutron,
				samsungTv,
				sonos,
				bond,
				islandRouter,
				jellyfish,
				venstar,
			}),
			health: createHealthHandler(state),
			lutronStatus: createLutronStatusHandler(state, lutron),
			lutronSetup: createLutronSetupHandler(state, lutron),
			rokuStatus: createRokuStatusHandler(state, config),
			rokuSetup: createRokuSetupHandler(state),
			sonosStatus: createSonosStatusHandler(state, sonos),
			sonosSetup: createSonosSetupHandler(state, sonos),
			samsungTvStatus: createSamsungTvStatusHandler(state, samsungTv),
			samsungTvSetup: createSamsungTvSetupHandler(state, samsungTv),
			bondStatus: createBondStatusHandler(state, bond),
			bondSetup: createBondSetupHandler(state, bond),
			jellyfishStatus: createJellyfishStatusHandler(state, jellyfish),
			jellyfishSetup: createJellyfishSetupHandler(state, config, jellyfish),
			venstarStatus: createVenstarStatusHandler(state, config, venstar),
			venstarSetup: createVenstarSetupHandler(state, config, venstar),
		},
	})

	return router
}
