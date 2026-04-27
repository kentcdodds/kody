import { expect, test, vi } from 'vitest'
import { createAppState } from '../../state.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createBondAdapter } from './index.ts'
import { adoptBondBridge, upsertDiscoveredBondBridges } from './repository.ts'

function createConfig(): HomeConnectorConfig {
	return {
		homeConnectorId: 'default',
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/home/connectors/default',
		workerWebSocketUrl: 'ws://localhost:3742/home/connectors/default',
		sharedSecret: 'secret',
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		jellyfishDiscoveryUrl: 'http://jellyfish.mock.local/discovery',
		venstarScanCidrs: ['192.168.10.40/32'],
		jellyfishScanCidrs: ['192.168.10.93/32'],
		dataPath: '/tmp',
		dbPath: ':memory:',
		port: 4040,
		mocksEnabled: false,
	}
}

function createDnsFetchError(message = 'getaddrinfo ENOTFOUND zpgi01117.local') {
	const error = new TypeError('fetch failed')
	Object.defineProperty(error, 'cause', {
		value: {
			code: 'ENOTFOUND',
			errno: -3008,
			syscall: 'getaddrinfo',
			hostname: 'zpgi01117.local',
			message,
		},
		enumerable: true,
		configurable: true,
	})
	return error
}

test('bond falls back to the discovered IP when the stored .local host stops resolving', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input)
		if (url === 'http://zpgi01117.local/v2/devices/mockdev1/state') {
			throw createDnsFetchError()
		}
		if (url === 'http://10.0.0.22/v2/devices/mockdev1/state') {
			return new Response(JSON.stringify({ position: 55, _: 's' }), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
				},
			})
		}
		throw new Error(`Unexpected fetch URL: ${url}`)
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST1',
				bondid: 'BONDTEST1',
				instanceName: 'Office Bond',
				host: 'zpgi01117.local',
				port: 80,
				address: '10.0.0.22',
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:00:00.000Z',
				rawDiscovery: {
					mdns: {
						host: 'zpgi01117.local.',
						addresses: ['10.0.0.22'],
					},
					version: {
						model: 'BD-TEST',
						fwVer: 'v1.0.0',
					},
				},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST1')
		bond.setToken('BONDTEST1', 'bond-token')

		const result = await bond.getDeviceState('BONDTEST1', 'mockdev1')

		expect(result).toMatchObject({
			position: 55,
		})
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			'http://zpgi01117.local/v2/devices/mockdev1/state',
		)
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			'http://10.0.0.22/v2/devices/mockdev1/state',
		)
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond surfaces actionable guidance when a .local bridge host cannot be resolved and no IP fallback exists', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	globalThis.fetch = vi.fn(async () => {
		throw createDnsFetchError()
	}) as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST2',
				bondid: 'BONDTEST2',
				instanceName: 'Bedroom Bond',
				host: 'zpgi01117.local',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:05:00.000Z',
				rawDiscovery: {
					mdns: {
						host: 'zpgi01117.local.',
						addresses: [],
					},
				},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST2')
		bond.setToken('BONDTEST2', 'bond-token')

		await expect(bond.getDeviceState('BONDTEST2', 'mockdev1')).rejects.toThrow(
			'Bond bridge "BONDTEST2" could not be reached while trying to fetch device mockdev1 state at http://zpgi01117.local',
		)
		await expect(bond.getDeviceState('BONDTEST2', 'mockdev1')).rejects.toThrow(
			'If this connector runs in a NAS/container without mDNS, update the bridge host to a stable IP',
		)
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})
