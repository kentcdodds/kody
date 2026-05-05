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
		bondRequestPaceMs: 0,
		bondCircuitBreakerCooldownMs: 0,
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

test('bond wraps response body timeouts as actionable network failures', async () => {
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
		return {
			ok: true,
			text: async () => {
				throw new DOMException('The operation timed out.', 'TimeoutError')
			},
		} as Response
	}) as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST9',
				bondid: 'BONDTEST9',
				instanceName: 'Body Timeout Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:40:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST9')
		bond.setToken('BONDTEST9', 'bond-token')

		await expect(bond.getDeviceState('BONDTEST9', 'mockdev1')).rejects.toThrow(
			'Bond bridge "BONDTEST9" could not be reached while trying to fetch device mockdev1 state at http://10.0.0.22. Bond request timed out after 5000ms for /v2/devices/mockdev1/state',
		)
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond wraps abort errors as actionable network failures', async () => {
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
		throw new DOMException('The user aborted a request.', 'AbortError')
	}) as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST10',
				bondid: 'BONDTEST10',
				instanceName: 'Abort Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:45:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST10')
		bond.setToken('BONDTEST10', 'bond-token')

		await expect(bond.getDeviceState('BONDTEST10', 'mockdev1')).rejects.toThrow(
			'Bond bridge "BONDTEST10" could not be reached while trying to fetch device mockdev1 state at http://10.0.0.22. The user aborted a request.',
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

test('bond serializes bridge requests and applies configured pacing', async () => {
	const config = {
		...createConfig(),
		bondRequestPaceMs: 250,
	}
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	vi.useFakeTimers()
	const testStart = Date.now()
	const fetchStarts: Array<number> = []
	globalThis.fetch = vi.fn(async () => {
		fetchStarts.push(Date.now() - testStart)
		await new Promise((resolve) => setTimeout(resolve, 10))
		return mockJsonResponse({ position: fetchStarts.length, _: 's' })
	}) as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST11',
				bondid: 'BONDTEST11',
				instanceName: 'Paced Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:50:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST11')
		bond.setToken('BONDTEST11', 'bond-token')

		const firstPromise = bond.getDeviceState('BONDTEST11', 'mockdev1')
		const secondPromise = bond.getDeviceState('BONDTEST11', 'mockdev2')
		await vi.advanceTimersByTimeAsync(9)
		expect(fetchStarts).toEqual([0])
		await vi.advanceTimersByTimeAsync(1)
		await firstPromise
		await vi.advanceTimersByTimeAsync(249)
		expect(fetchStarts).toEqual([0])
		await vi.advanceTimersByTimeAsync(1)
		await vi.advanceTimersByTimeAsync(10)
		await secondPromise

		expect(fetchStarts).toEqual([0, 260])
		expect(bond.getReliabilityStatus({ bridgeId: 'BONDTEST11' })).toMatchObject({
			recentRequestLogs: [
				{ operation: 'fetch device mockdev2 state', status: 'success' },
				{ operation: 'fetch device mockdev1 state', status: 'success' },
			],
		})
	} finally {
		vi.useRealTimers()
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond cooldown prevents follow-up requests after network failures', async () => {
	const config = {
		...createConfig(),
		bondCircuitBreakerCooldownMs: 60_000,
	}
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	vi.useFakeTimers()
	globalThis.fetch = vi.fn(async () => {
		throw createDnsFetchError('getaddrinfo ENOTFOUND 10.0.0.22')
	}) as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST13',
				bondid: 'BONDTEST13',
				instanceName: 'Cooldown Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T22:00:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST13')
		bond.setToken('BONDTEST13', 'bond-token')

		await bond.getDeviceState('BONDTEST13', 'mockdev1').catch(() => null)
		const error = await bond
			.getDeviceState('BONDTEST13', 'mockdev2')
			.catch((caughtError: unknown) => caughtError)

		expect(error).toBeInstanceOf(Error)
		expect((error as Error).name).toBe('BondCircuitBreakerError')
		expect(globalThis.fetch).toHaveBeenCalledTimes(1)
		const status = bond.getReliabilityStatus({ bridgeId: 'BONDTEST13' })
		expect(status.persisted?.lastFailureReason).toContain('fetch failed')
		expect(
			status.recentRequestLogs.map((log) => ({
				status: log.status,
				baseUrlsTried: log.baseUrlsTried,
			})),
		).toEqual([
			{ status: 'cooldown', baseUrlsTried: [] },
			{ status: 'failure', baseUrlsTried: ['http://10.0.0.22'] },
		])
	} finally {
		vi.useRealTimers()
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond serializes paced bridge requests and writes request logs', async () => {
	const config = {
		...createConfig(),
		bondRequestPaceMs: 100,
	}
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	vi.useFakeTimers()
	const fetchStarts: Array<number> = []
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		fetchStarts.push(Date.now())
		const url = String(input)
		if (url === 'http://10.0.0.22/v2/devices/dev1/state') {
			return mockJsonResponse({ position: 10, _: 's1' })
		}
		if (url === 'http://10.0.0.22/v2/devices/dev2/state') {
			return mockJsonResponse({ position: 20, _: 's2' })
		}
		throw new Error(`Unexpected fetch URL: ${url}`)
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST11',
				bondid: 'BONDTEST11',
				instanceName: 'Queued Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:50:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST11')
		bond.setToken('BONDTEST11', 'bond-token')

		const first = bond.getDeviceState('BONDTEST11', 'dev1')
		const second = bond.getDeviceState('BONDTEST11', 'dev2')
		await vi.advanceTimersByTimeAsync(0)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(99)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)

		await expect(first).resolves.toMatchObject({ position: 10 })
		await expect(second).resolves.toMatchObject({ position: 20 })
		expect(fetchStarts[1]! - fetchStarts[0]!).toBeGreaterThanOrEqual(100)
		const status = bond.getReliabilityStatus({
			bridgeId: 'BONDTEST11',
			limit: 10,
		})
		expect(status.recentRequestLogs).toHaveLength(2)
		expect(status.recentRequestLogs.map((log) => log.status)).toEqual([
			'success',
			'success',
		])
	} finally {
		vi.useRealTimers()
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond coalesces duplicate device state reads while one is in flight', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	let resolveFetch: ((response: Response) => void) | null = null
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input)
		if (url !== 'http://10.0.0.22/v2/devices/mockdev1/state') {
			throw new Error(`Unexpected fetch URL: ${url}`)
		}
		return await new Promise<Response>((resolve) => {
			resolveFetch = resolve
		})
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST12',
				bondid: 'BONDTEST12',
				instanceName: 'Coalesced Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T21:55:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST12')
		bond.setToken('BONDTEST12', 'bond-token')

		const first = bond.getDeviceState('BONDTEST12', 'mockdev1')
		const second = bond.getDeviceState('BONDTEST12', 'mockdev1')
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
		resolveFetch?.(mockJsonResponse({ position: 77, _: 's' }))

		await expect(first).resolves.toMatchObject({ position: 77 })
		await expect(second).resolves.toMatchObject({ position: 77 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(
			bond.getReliabilityStatus({
				bridgeId: 'BONDTEST12',
			}).recentRequestLogs,
		).toHaveLength(1)
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond coalesces duplicate queued device state reads until the shared request settles', async () => {
	const config = {
		...createConfig(),
		bondRequestPaceMs: 2_000,
	}
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	vi.useFakeTimers()
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input)
		if (url === 'http://10.0.0.22/v2/devices/blocker/state') {
			return mockJsonResponse({ position: 1, _: 'blocker' })
		}
		if (url === 'http://10.0.0.22/v2/devices/queued/state') {
			return mockJsonResponse({ position: 2, _: 'queued' })
		}
		throw new Error(`Unexpected fetch URL: ${url}`)
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST14',
				bondid: 'BONDTEST14',
				instanceName: 'Long Queue Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T22:05:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST14')
		bond.setToken('BONDTEST14', 'bond-token')

		const blocker = bond.getDeviceState('BONDTEST14', 'blocker')
		await vi.advanceTimersByTimeAsync(0)
		await expect(blocker).resolves.toMatchObject({ position: 1 })

		const firstQueued = bond.getDeviceState('BONDTEST14', 'queued')
		await vi.advanceTimersByTimeAsync(1_500)
		const secondQueued = bond.getDeviceState('BONDTEST14', 'queued')
		await vi.advanceTimersByTimeAsync(500)

		await expect(firstQueued).resolves.toMatchObject({ position: 2 })
		await expect(secondQueued).resolves.toMatchObject({ position: 2 })
		expect(
			fetchMock.mock.calls.filter((call) =>
				String(call[0]).endsWith('/v2/devices/queued/state'),
			),
		).toHaveLength(1)
	} finally {
		vi.useRealTimers()
		globalThis.fetch = previousFetch
		storage.close()
	}
})

test('bond enters cooldown after network failure and rejects queued requests', async () => {
	const config = {
		...createConfig(),
		bondCircuitBreakerCooldownMs: 60_000,
	}
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const previousFetch = globalThis.fetch
	vi.useFakeTimers()
	const fetchMock = vi.fn(async () => {
		throw createDnsFetchError('getaddrinfo ENOTFOUND 10.0.0.22')
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		upsertDiscoveredBondBridges(storage, config.homeConnectorId, [
			{
				bridgeId: 'BONDTEST13',
				bondid: 'BONDTEST13',
				instanceName: 'Cooldown Bond',
				host: '10.0.0.22',
				port: 80,
				address: null,
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-27T22:00:00.000Z',
				rawDiscovery: {},
			},
		])
		adoptBondBridge(storage, config.homeConnectorId, 'BONDTEST13')
		bond.setToken('BONDTEST13', 'bond-token')

		await expect(bond.getDeviceState('BONDTEST13', 'dev1')).rejects.toThrow(
			'Bond bridge "BONDTEST13" could not be reached',
		)
		await expect(bond.getDeviceState('BONDTEST13', 'dev2')).rejects.toThrow(
			'cooling down after a recent network failure',
		)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const status = bond.getReliabilityStatus({
			bridgeId: 'BONDTEST13',
			limit: 10,
		})
		expect(status.queue.cooldownUntil).toBeTruthy()
		expect(status.persisted?.cooldownUntil).toBeTruthy()
		expect(
			status.recentRequestLogs.map((log) => ({
				status: log.status,
				baseUrlsTried: log.baseUrlsTried,
			})),
		).toEqual([
			{ status: 'cooldown', baseUrlsTried: [] },
			{ status: 'failure', baseUrlsTried: ['http://10.0.0.22'] },
		])
	} finally {
		vi.useRealTimers()
		globalThis.fetch = previousFetch
		storage.close()
	}
})
