import { expect, test, vi } from 'vitest'
import { createAppState } from '../../state.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import { scanAccessNetworksUnleashedControllers } from './discovery.ts'

function createConfig(scanCidrs: Array<string>): HomeConnectorConfig {
	return {
		homeConnectorId: 'default',
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/home/connectors/default',
		workerWebSocketUrl: 'ws://localhost:3742/home/connectors/default',
		sharedSecret: 'secret',
		accessNetworksUnleashedScanCidrs: scanCidrs,
		accessNetworksUnleashedAllowInsecureTls: true,
		accessNetworksUnleashedRequestTimeoutMs: 1_500,
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
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		bondRequestPaceMs: 500,
		bondCircuitBreakerCooldownMs: 60_000,
		jellyfishDiscoveryUrl: null,
		venstarScanCidrs: ['192.168.10.40/32'],
		jellyfishScanCidrs: ['192.168.10.93/32'],
		dataPath: '/tmp',
		dbPath: ':memory:',
		port: 4040,
		mocksEnabled: false,
	}
}

test('access networks unleashed subnet discovery finds controllers and diagnostics', async () => {
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString()
		if (url === 'https://10.0.0.55/') {
			return new Response(null, {
				status: 302,
				headers: {
					Location: '/admin/wsg/login.jsp',
				},
			})
		}
		return new Response('not found', { status: 404 })
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		const state = createAppState()
		const config = createConfig(['10.0.0.55/32'])

		const result = await scanAccessNetworksUnleashedControllers(state, config)

		expect(result.controllers).toHaveLength(1)
		expect(result.controllers[0]).toMatchObject({
			controllerId: '10.0.0.55',
			host: '10.0.0.55',
			loginUrl: 'https://10.0.0.55/admin/wsg/login.jsp',
		})
		expect(result.diagnostics.subnetProbe).toMatchObject({
			cidrs: ['10.0.0.55/32'],
			hostsProbed: 1,
			controllerMatches: 1,
		})
		expect(result.diagnostics.probes[0]).toMatchObject({
			host: '10.0.0.55',
			matched: true,
			matchReason: 'redirect',
		})
		expect(
			state.accessNetworksUnleashedDiscoveryDiagnostics?.probes,
		).toHaveLength(1)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('access networks unleashed subnet discovery skips invalid CIDRs and keeps scanning', async () => {
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString()
		if (url === 'https://10.0.0.42/') {
			return new Response(
				'<html><title>Ruckus Unleashed</title><body>Access Networks Unleashed Login</body></html>',
				{
					status: 200,
					headers: {
						'Content-Type': 'text/html',
					},
				},
			)
		}
		return new Response('not found', { status: 404 })
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		const state = createAppState()
		const config = createConfig(['bad-cidr', '10.0.0.42/32'])

		const result = await scanAccessNetworksUnleashedControllers(state, config)

		expect(result.controllers).toHaveLength(1)
		expect(result.controllers[0]?.controllerId).toBe('10.0.0.42')
		expect(result.diagnostics.subnetProbe).toMatchObject({
			cidrs: ['bad-cidr', '10.0.0.42/32'],
			hostsProbed: 1,
			controllerMatches: 1,
		})
		expect(result.diagnostics.probes[0]?.matchReason).toBe('login-page')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('access networks unleashed discovery keeps the last non-match diagnostic details', async () => {
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString()
		if (url === 'https://10.0.0.90/') {
			return new Response('<html><title>Welcome</title></html>', {
				status: 200,
				headers: {
					'Content-Type': 'text/html',
				},
			})
		}
		if (url === 'https://10.0.0.90/admin/') {
			return new Response('forbidden', {
				status: 403,
				headers: {
					'Content-Type': 'text/plain',
				},
			})
		}
		if (url === 'https://10.0.0.90/admin/login.jsp') {
			return new Response('still not a controller', {
				status: 404,
			})
		}
		return new Response('not found', { status: 404 })
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		const state = createAppState()
		const config = createConfig(['10.0.0.90/32'])

		const result = await scanAccessNetworksUnleashedControllers(state, config)

		expect(result.controllers).toHaveLength(0)
		expect(result.diagnostics.probes[0]).toMatchObject({
			host: '10.0.0.90',
			url: 'https://10.0.0.90/admin/login.jsp',
			status: 404,
			matched: false,
			bodySnippet: 'still not a controller',
		})
	} finally {
		globalThis.fetch = previousFetch
	}
})
