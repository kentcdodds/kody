import { expect, test, vi } from 'vitest'
import { createAppState } from '../../state.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import { scanVenstarThermostats } from './discovery.ts'

function createConfig(scanCidrs: Array<string>): HomeConnectorConfig {
	return {
		homeConnectorId: 'default',
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/home/connectors/default',
		workerWebSocketUrl: 'ws://localhost:3742/home/connectors/default',
		sharedSecret: 'secret',
		accessNetworksUnleashedScanCidrs: ['192.168.1.10/32'],
		accessNetworksUnleashedAllowInsecureTls: false,
		accessNetworksUnleashedRequestTimeoutMs: 8_000,
		islandRouterHost: null,
		islandRouterPort: 22,
		islandRouterUsername: null,
		islandRouterPrivateKeyPath: null,
		islandRouterKnownHostsPath: null,
		islandRouterHostFingerprint: null,
		islandRouterCommandTimeoutMs: 8_000,
		islandRouterApiBaseUrl: 'https://my.islandrouter.com',
		islandRouterApiRequestTimeoutMs: 8_000,
		islandRouterApiAllowInsecureTls: false,
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		bondRequestPaceMs: 500,
		bondCircuitBreakerCooldownMs: 60_000,
		jellyfishDiscoveryUrl: null,
		venstarScanCidrs: scanCidrs,
		jellyfishScanCidrs: ['192.168.10.93/32'],
		dataPath: '/tmp',
		dbPath: ':memory:',
		port: 4040,
		mocksEnabled: false,
	}
}

test('venstar subnet discovery finds thermostat details and diagnostics', async () => {
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString()
		if (url === 'http://10.0.0.88/query/info') {
			return new Response(
				JSON.stringify({
					name: 'Living Room Thermostat',
					mode: 3,
					state: 1,
					fan: 0,
					spacetemp: 72,
					heattemp: 68,
					cooltemp: 75,
					humidity: 40,
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			)
		}
		return new Response('not found', { status: 404 })
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		const state = createAppState()
		const config = createConfig(['10.0.0.88/32'])

		const result = await scanVenstarThermostats(state, config)

		expect(result.thermostats).toHaveLength(1)
		expect(result.thermostats[0]).toMatchObject({
			name: 'Living Room Thermostat',
			ip: '10.0.0.88',
			location: 'http://10.0.0.88/',
		})
		expect(result.diagnostics.protocol).toBe('subnet')
		expect(result.diagnostics.ssdpHits).toEqual([])
		expect(result.diagnostics.infoLookups).toHaveLength(1)
		expect(result.diagnostics.infoLookups[0]?.parsed).toMatchObject({
			name: 'Living Room Thermostat',
			spacetemp: 72,
			humidity: 40,
		})
		expect(result.diagnostics.subnetProbe).toMatchObject({
			cidrs: ['10.0.0.88/32'],
			hostsProbed: 1,
			venstarMatches: 1,
		})
		expect(state.venstarDiscoveredThermostats).toHaveLength(1)
		expect(state.venstarDiscoveryDiagnostics?.infoLookups).toHaveLength(1)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('venstar subnet discovery skips invalid CIDRs and still scans valid ones', async () => {
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString()
		if (url === 'http://10.0.0.42/query/info') {
			return new Response(
				JSON.stringify({
					name: 'Office',
					mode: 1,
					state: 0,
					fan: 0,
					spacetemp: 70,
					heattemp: 68,
					cooltemp: 74,
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			)
		}
		return new Response('not found', { status: 404 })
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		const state = createAppState()
		const config = createConfig(['not-a-cidr', '10.0.0.42/32'])

		const result = await scanVenstarThermostats(state, config)

		expect(result.thermostats).toHaveLength(1)
		expect(result.thermostats[0]?.ip).toBe('10.0.0.42')
		expect(result.diagnostics.subnetProbe).toMatchObject({
			cidrs: ['not-a-cidr', '10.0.0.42/32'],
			hostsProbed: 1,
			venstarMatches: 1,
		})
	} finally {
		globalThis.fetch = previousFetch
	}
})
