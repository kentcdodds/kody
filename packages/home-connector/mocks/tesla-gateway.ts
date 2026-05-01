/**
 * MSW handlers for the Tesla gateway discovery JSON feed used in dev/test.
 *
 * The connector itself talks to gateways via raw `node:https`, not `fetch`, so
 * those calls cannot be MSW-intercepted. Instead, the adapter detects hosts
 * ending in `.mock.local` and routes calls directly through the mock-driver
 * fixtures (see `src/adapters/tesla-gateway/mock-driver.ts`). MSW only needs
 * to handle the JSON discovery feed used by the dev server when
 * `TESLA_GATEWAY_DISCOVERY_URL` is set.
 */
import { http, HttpResponse } from 'msw'
import { listMockTeslaGatewayDiscoveryEntries } from '../src/adapters/tesla-gateway/mock-driver.ts'

const discoveryPattern = /^http:\/\/tesla-gateway\.mock\.local\/discovery\/?$/

export const teslaGatewayHandlers = [
	http.get(discoveryPattern, () => {
		return HttpResponse.json({
			gateways: listMockTeslaGatewayDiscoveryEntries(),
		})
	}),
]
