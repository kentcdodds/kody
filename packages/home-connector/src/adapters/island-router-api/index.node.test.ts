import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { type HomeConnectorConfig } from '../../config.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import {
	createIslandRouterApiAdapter,
	islandRouterApiWriteConfirmation,
} from './index.ts'
import { computeIslandRouterHotp } from './otp.ts'
import { saveIslandRouterApiPin } from './repository.ts'

type IslandRouterApiFetch = typeof fetch

function createConfig(
	dbPath: string,
	overrides: Partial<HomeConnectorConfig> = {},
): HomeConnectorConfig {
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
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		bondRequestPaceMs: 0,
		bondCircuitBreakerCooldownMs: 0,
		jellyfishDiscoveryUrl: 'http://jellyfish.mock.local/discovery',
		venstarScanCidrs: ['192.168.10.40/32'],
		jellyfishScanCidrs: ['192.168.10.93/32'],
		dataPath: path.dirname(dbPath),
		dbPath,
		port: 4040,
		mocksEnabled: true,
		...overrides,
	}
}

function createJsonResponse(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json',
		},
	})
}

test('encrypted PIN round-trips in sqlite and requires HOME_CONNECTOR_SHARED_SECRET', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-island-router-api-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = createHomeConnectorStorage(createConfig(dbPath))
	try {
		const adapter = createIslandRouterApiAdapter({
			config: createConfig(dbPath),
			storage,
			fetchImpl: async () => createJsonResponse({}),
		})
		expect(adapter.getStatus()).toMatchObject({
			configured: false,
			hasStoredPin: false,
		})
		expect(adapter.setPin(' 123456 ')).toMatchObject({
			configured: true,
			hasStoredPin: true,
		})
		const row = storage.db
			.query(
				`
					SELECT pin
					FROM island_router_api_credentials
					WHERE connector_id = ?
				`,
			)
			.get('default') as { pin: string } | undefined
		expect(row?.pin).toMatch(/^enc:v1:/)
		expect(row?.pin).not.toContain('123456')
		adapter.clearPin()
		expect(adapter.getStatus()).toMatchObject({
			configured: false,
			hasStoredPin: false,
		})

		const missingSecretStorage = createHomeConnectorStorage(
			createConfig(':memory:', { sharedSecret: null }),
		)
		try {
			expect(() =>
				saveIslandRouterApiPin({
					storage: missingSecretStorage,
					connectorId: 'default',
					pin: '123456',
				}),
			).toThrow('HOME_CONNECTOR_SHARED_SECRET')
		} finally {
			missingSecretStorage.close()
		}
	} finally {
		storage.close()
		rmSync(directory, { force: true, recursive: true })
	}
})

test('HOTP computation matches RFC 4226 vectors', () => {
	const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
	expect(computeIslandRouterHotp({ secret, counter: 0 })).toBe('755224')
	expect(computeIslandRouterHotp({ secret, counter: 1 })).toBe('287082')
	expect(computeIslandRouterHotp({ secret, counter: 9 })).toBe('520489')
})

test('auth handshake sends startup, PIN OTP exchange, and bearer request', async () => {
	const storage = createHomeConnectorStorage(createConfig(':memory:'))
	const requests: Array<{
		url: string
		init: RequestInit
		body: unknown
	}> = []
	const fetchImpl: IslandRouterApiFetch = async (url, init = {}) => {
		requests.push({
			url: String(url),
			init,
			body: init?.body ? JSON.parse(String(init.body)) : null,
		})
		if (String(url).endsWith('/api/startup') && requests.length === 1) {
			return createJsonResponse({
				data: {
					id: 'startup-id',
					c: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
					d: 1,
				},
			})
		}
		if (String(url).endsWith('/api/startup') && requests.length === 2) {
			return createJsonResponse({
				data: {
					session: 'session-token',
					access: 'access-token',
					refresh: 'refresh-token',
				},
			})
		}
		return createJsonResponse({ filters: [] })
	}
	try {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-05-05T00:00:00.000Z'))
		const adapter = createIslandRouterApiAdapter({
			config: createConfig(':memory:'),
			storage,
			fetchImpl,
		})
		adapter.setPin('246810')
		const result = await adapter.request({
			method: 'GET',
			path: '/api/filters',
		})
		expect(result).toMatchObject({
			method: 'GET',
			path: '/api/filters',
			status: 200,
			data: { filters: [] },
		})
		const timeBlocks = Math.floor(Date.now() / 1000 / 30)
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			'/api/startup',
			'/api/startup',
			'/api/filters',
		])
		expect(requests[0]?.body).toEqual({ timeBlocks })
		expect(requests[1]?.body).toEqual({
			id: 'startup-id',
			pin: '246810',
			otp: computeIslandRouterHotp({
				secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
				counter: timeBlocks + 1,
			}),
			timeBlocks,
		})
		expect(
			(requests[2]?.init.headers as Record<string, string>)?.authorization,
		).toBe('Bearer access-token')
	} finally {
		vi.useRealTimers()
		storage.close()
	}
})

test('401 refreshes tokens and retries once, but a second 401 surfaces auth error', async () => {
	const storage = createHomeConnectorStorage(createConfig(':memory:'))
	let filtersCalls = 0
	let refreshCalls = 0
	let startupCalls = 0
	const fetchImpl: IslandRouterApiFetch = async (url) => {
		const pathName = new URL(String(url)).pathname
		if (pathName === '/api/startup') {
			startupCalls += 1
			if (startupCalls % 2 === 1) {
				return createJsonResponse({
					data: {
						id: 'startup-id',
						c: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
						d: 0,
					},
				})
			}
			return createJsonResponse({
				data: {
					session: 'session-token',
					access: 'access-token',
					refresh: 'refresh-token',
				},
			})
		}
		if (pathName === '/api/refresh') {
			refreshCalls += 1
			return createJsonResponse({
				data: {
					session: 'session-token-2',
					access: 'access-token-2',
					refresh: 'refresh-token-2',
				},
			})
		}
		filtersCalls += 1
		return filtersCalls === 1
			? createJsonResponse({ error: 'expired' }, 401)
			: createJsonResponse({ filters: ['ok'] })
	}
	try {
		const adapter = createIslandRouterApiAdapter({
			config: createConfig(':memory:'),
			storage,
			fetchImpl,
		})
		adapter.setPin('246810')
		await expect(
			adapter.request({
				method: 'GET',
				path: '/api/filters',
			}),
		).resolves.toMatchObject({
			status: 200,
			data: { filters: ['ok'] },
		})
		expect(startupCalls).toBe(2)
		expect(refreshCalls).toBe(1)
	} finally {
		storage.close()
	}

	const failingStorage = createHomeConnectorStorage(createConfig(':memory:'))
	let failingFiltersCalls = 0
	let failingStartupCalls = 0
	const failingFetch: IslandRouterApiFetch = async (url) => {
		const pathName = new URL(String(url)).pathname
		if (pathName === '/api/startup') {
			failingStartupCalls += 1
			return failingStartupCalls % 2 === 1
				? createJsonResponse({
						data: {
							id: 'startup-id',
							c: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
							d: 0,
						},
					})
				: createJsonResponse({
						data: {
							session: 'session-token',
							access: 'access-token',
							refresh: 'refresh-token',
						},
					})
		}
		if (pathName === '/api/refresh') {
			return createJsonResponse({
				data: {
					session: 'session-token-2',
					access: 'access-token-2',
					refresh: 'refresh-token-2',
				},
			})
		}
		failingFiltersCalls += 1
		return createJsonResponse({ error: 'unauthorized' }, 401)
	}
	try {
		const adapter = createIslandRouterApiAdapter({
			config: createConfig(':memory:'),
			storage: failingStorage,
			fetchImpl: failingFetch,
		})
		adapter.setPin('246810')
		await expect(
			adapter.request({
				method: 'GET',
				path: '/api/filters',
			}),
		).rejects.toThrow('remained unauthorized')
		expect(failingFiltersCalls).toBe(2)
	} finally {
		failingStorage.close()
	}
})

test('request rejects invalid paths and high-risk writes without acknowledgement', async () => {
	const storage = createHomeConnectorStorage(createConfig(':memory:'))
	try {
		const adapter = createIslandRouterApiAdapter({
			config: createConfig(':memory:'),
			storage,
			fetchImpl: async () => createJsonResponse({}),
		})
		adapter.setPin('246810')
		await expect(
			adapter.request({ method: 'GET', path: '/filters' }),
		).rejects.toThrow('begin with /api/')
		await expect(
			adapter.request({ method: 'GET', path: '/api/filters\nbad' }),
		).rejects.toThrow('control characters')
		await expect(
			adapter.request({ method: 'GET', path: '/api/%2e%2e/filters' }),
		).rejects.toThrow('escape /api/')
		await expect(
			adapter.request({
				method: 'POST',
				path: '/api/filters',
				body: { name: 'Example' },
			}),
		).rejects.toThrow('acknowledgeHighRisk')
		await expect(
			adapter.request({
				method: 'POST',
				path: '/api/filters',
				body: { name: 'Example' },
				acknowledgeHighRisk: true,
				reason: 'too short',
				confirmation: islandRouterApiWriteConfirmation,
			}),
		).rejects.toThrow('reason must be at least 20 characters')
		await expect(
			adapter.request({
				method: 'POST',
				path: '/api/filters',
				body: { name: 'Example' },
				acknowledgeHighRisk: true,
				reason: 'Create an API filter for an explicitly requested policy.',
				confirmation: 'wrong',
			}),
		).rejects.toThrow('confirmation must exactly equal')
	} finally {
		storage.close()
	}
})
