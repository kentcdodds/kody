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
import {
	createBondSetupHandler,
	createBondStatusHandler,
} from './bond-handlers.ts'
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
import { type createSonosAdapter } from '../src/adapters/sonos/index.ts'
import { type createSamsungTvAdapter } from '../src/adapters/samsung-tv/index.ts'
import { type createVenstarAdapter } from '../src/adapters/venstar/index.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { type HomeConnectorState } from '../src/state.ts'

export function createHomeConnectorRouter(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	lutron: ReturnType<typeof createLutronAdapter>,
	samsungTv: ReturnType<typeof createSamsungTvAdapter>,
	sonos: ReturnType<typeof createSonosAdapter>,
	bond: ReturnType<typeof createBondAdapter>,
	venstar: ReturnType<typeof createVenstarAdapter>,
) {
	const router = createRouter({
		middleware: [],
	})

	router.map(
		routes.home,
		createHomeDashboardHandler(state, lutron, samsungTv, sonos, bond, venstar),
	)
	router.map(routes.health, createHealthHandler(state))
	router.map(routes.lutronStatus, createLutronStatusHandler(state, lutron))
	router.map(routes.lutronSetup, createLutronSetupHandler(state, lutron))
	router.map(routes.rokuStatus, createRokuStatusHandler(state, config))
	router.map(routes.rokuSetup, createRokuSetupHandler(state))
	router.map(routes.sonosStatus, createSonosStatusHandler(state, sonos))
	router.map(routes.sonosSetup, createSonosSetupHandler(state, sonos))
	router.map(
		routes.samsungTvStatus,
		createSamsungTvStatusHandler(state, samsungTv),
	)
	router.map(
		routes.samsungTvSetup,
		createSamsungTvSetupHandler(state, samsungTv),
	)
	router.map(routes.bondStatus, createBondStatusHandler(state, bond))
	router.map(routes.bondSetup, createBondSetupHandler(state, bond))
	router.map(
		routes.venstarStatus,
		createVenstarStatusHandler(state, config, venstar),
	)
	router.map(
		routes.venstarSetup,
		createVenstarSetupHandler(state, config, venstar),
	)

	return router
}
