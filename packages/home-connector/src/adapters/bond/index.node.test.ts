import { expect, test, vi } from 'vitest'
import { createAppState } from '../../state.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createBondAdapter } from './index.ts'
import {
	adoptBondBridge,
	requireBondBridge,
	upsertDiscoveredBondBridges,
} from './repository.ts'

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

function createDnsFetchError(
	message = 'getaddrinfo ENOTFOUND zpgi01117.local',
) {
	return new TypeError('fetch failed', {
		cause: {
			code: 'ENOTFOUND',
			errno: -3008,
			syscall: 'getaddrinfo',
			hostname: 'zpgi01117.local',
			message,
		},
	})
}

function createTcpResetFetchError(message = 'read ECONNRESET') {
	return new TypeError('fetch failed', {
		cause: new Error(message),
	})
}

function mockJsonResponse(body: Record<string, unknown>) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			'Content-Type': 'application/json',
		},
	})
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
			return mockJsonResponse({ position: 55, _: 's' })
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

		const before = bond
			.getStatus()
			.bridges.find((bridge) => bridge.bridgeId === 'BONDTEST1')
		const result = await bond.getDeviceState('BONDTEST1', 'mockdev1')
		const after = bond
			.getStatus()
			.bridges.find((bridge) => bridge.bridgeId === 'BONDTEST1')

		expect(result).toMatchObject({
			position: 55,
		})
		expect(before?.lastSeenAt).toBe('2026-04-27T21:00:00.000Z')
		expect(after?.lastSeenAt).not.toBe(before?.lastSeenAt)
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

test('bond retries transient TCP resets with exponential backoff when reading device state', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	vi.useFakeTimers()
	const fetchMock = vi
		.fn()
		.mockRejectedValueOnce(createTcpResetFetchError())
		.mockRejectedValueOnce(createTcpResetFetchError('socket hang up'))
		.mockResolvedValueOnce(mockJsonResponse({ position: 21, _: 's' }))
	globalThis.fetch = fetchMock as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST4',
				bondid: 'BONDTEST4',
				instanceName: 'Reset-Prone Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:15:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST4')
		bond.setToken('BONDTEST4', 'bond-token')

		const resultPromise = bond.getDeviceState('BONDTEST4', 'mockdev1')
		await vi.advanceTimersByTimeAsync(99)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(199)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		const result = await resultPromise

		expect(result).toMatchObject({
			position: 21,
		})
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			'http://10.0.0.22/v2/devices/mockdev1/state',
		)
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			'http://10.0.0.22/v2/devices/mockdev1/state',
		)
		expect(fetchMock.mock.calls[2]?.[0]).toBe(
			'http://10.0.0.22/v2/devices/mockdev1/state',
		)
	} finally {
		vi.useRealTimers()
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

		const error = await bond
			.getDeviceState('BONDTEST2', 'mockdev1')
			.catch((caughtError: unknown) => caughtError)

		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toContain(
			'Bond bridge "BONDTEST2" could not be reached while trying to fetch device mockdev1 state at http://zpgi01117.local',
		)
		expect((error as Error).message).toContain(
			'If this connector runs in a NAS/container without mDNS, update the bridge host to a stable IP',
		)
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond leaves non-network Bond API errors unwrapped and does not claim fallback URLs were tried', async () => {
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
			return new Response(JSON.stringify({ message: 'unauthorized' }), {
				status: 401,
				headers: {
					'Content-Type': 'application/json',
				},
			})
		}
		if (url === 'http://10.0.0.22/v2/devices/mockdev1/state') {
			throw new Error('Fallback URL should not have been called')
		}
		throw new Error(`Unexpected fetch URL: ${url}`)
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST3',
				bondid: 'BONDTEST3',
				instanceName: 'Kitchen Bond',
				host: 'zpgi01117.local',
				port: 80,
				address: '10.0.0.22',
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:10:00.000Z',
				rawDiscovery: {
					address: '10.0.0.22',
				},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST3')
		bond.setToken('BONDTEST3', 'bond-token')

		await expect(bond.getDeviceState('BONDTEST3', 'mockdev1')).rejects.toThrow(
			'Bond HTTP 401 for /v2/devices/mockdev1/state: unauthorized',
		)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			'http://zpgi01117.local/v2/devices/mockdev1/state',
		)
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond recovers SetPosition when the action response resets but state reaches the requested position', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (
				url === 'http://10.0.0.22/v2/devices/mockdev1' &&
				init?.method === 'GET'
			) {
				return mockJsonResponse({ actions: ['Open', 'SetPosition'] })
			}
			if (
				url === 'http://10.0.0.22/v2/devices/mockdev1/actions/SetPosition' &&
				init?.method === 'PUT'
			) {
				throw createTcpResetFetchError()
			}
			if (url === 'http://10.0.0.22/v2/devices/mockdev1/state') {
				return mockJsonResponse({ position: 40, _: 's' })
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		},
	)
	globalThis.fetch = fetchMock as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST5',
				bondid: 'BONDTEST5',
				instanceName: 'Recoverable Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:20:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST5')
		bond.setToken('BONDTEST5', 'bond-token')

		const result = await bond.shadeSetPosition({
			bridgeId: 'BONDTEST5',
			deviceId: 'mockdev1',
			position: 40,
		})

		expect(result).toMatchObject({
			confirmed: true,
			recoveredFrom: 'transient_action_network_failure',
			state: { position: 40 },
		})
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
			'http://10.0.0.22/v2/devices/mockdev1',
			'http://10.0.0.22/v2/devices/mockdev1/actions/SetPosition',
			'http://10.0.0.22/v2/devices/mockdev1/state',
		])
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond still reports SetPosition reset when follow-up state does not match', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (
				url === 'http://10.0.0.22/v2/devices/mockdev1' &&
				init?.method === 'GET'
			) {
				return mockJsonResponse({ actions: ['Open', 'SetPosition'] })
			}
			if (
				url === 'http://10.0.0.22/v2/devices/mockdev1/actions/SetPosition' &&
				init?.method === 'PUT'
			) {
				throw createTcpResetFetchError()
			}
			if (url === 'http://10.0.0.22/v2/devices/mockdev1/state') {
				return mockJsonResponse({ position: 20, _: 's' })
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		},
	)
	globalThis.fetch = fetchMock as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST6',
				bondid: 'BONDTEST6',
				instanceName: 'Unrecovered Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:25:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST6')
		bond.setToken('BONDTEST6', 'bond-token')

		await expect(
			bond.shadeSetPosition({
				bridgeId: 'BONDTEST6',
				deviceId: 'mockdev1',
				position: 40,
			}),
		).rejects.toThrow(
			'Bond bridge "BONDTEST6" could not be reached while trying to invoke device mockdev1 action SetPosition',
		)
		expect(fetchMock).toHaveBeenCalledTimes(3)
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond preserves SetPosition reset when follow-up state read fails', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (
				url === 'http://10.0.0.22/v2/devices/mockdev1' &&
				init?.method === 'GET'
			) {
				return mockJsonResponse({ actions: ['Open', 'SetPosition'] })
			}
			if (
				url === 'http://10.0.0.22/v2/devices/mockdev1/actions/SetPosition' &&
				init?.method === 'PUT'
			) {
				throw createTcpResetFetchError()
			}
			if (url === 'http://10.0.0.22/v2/devices/mockdev1/state') {
				throw createDnsFetchError('getaddrinfo ENOTFOUND 10.0.0.22')
			}
			throw new Error(`Unexpected fetch URL: ${url}`)
		},
	)
	globalThis.fetch = fetchMock as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST8',
				bondid: 'BONDTEST8',
				instanceName: 'State-Read-Failure Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:35:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST8')
		bond.setToken('BONDTEST8', 'bond-token')

		await expect(
			bond.shadeSetPosition({
				bridgeId: 'BONDTEST8',
				deviceId: 'mockdev1',
				position: 40,
			}),
		).rejects.toThrow(
			'Bond bridge "BONDTEST8" could not be reached while trying to invoke device mockdev1 action SetPosition',
		)
		expect(fetchMock).toHaveBeenCalledTimes(3)
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond wraps request timeouts as actionable network failures', async () => {
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
		throw new DOMException('The operation timed out.', 'TimeoutError')
	}) as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST7',
				bondid: 'BONDTEST7',
				instanceName: 'Timeout Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:30:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST7')
		bond.setToken('BONDTEST7', 'bond-token')

		await expect(bond.getDeviceState('BONDTEST7', 'mockdev1')).rejects.toThrow(
			'Bond bridge "BONDTEST7" could not be reached while trying to fetch device mockdev1 state at http://10.0.0.22. Bond request timed out after 5000ms for /v2/devices/mockdev1/state',
		)
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond does not refresh bridge lastSeenAt after failed requests', async () => {
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
				bridgeId: 'BONDTEST8',
				bondid: 'BONDTEST8',
				instanceName: 'Failed Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:35:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST8')
		bond.setToken('BONDTEST8', 'bond-token')

		await bond.getDeviceState('BONDTEST8', 'mockdev1').catch(() => null)

		expect(
			requireBondBridge(storage, config.homeConnectorId, 'BONDTEST8')
				.lastSeenAt,
		).toBe('2026-04-27T21:35:00.000Z')
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})
