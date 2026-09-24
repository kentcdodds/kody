import { expect, test } from 'vitest'
import { createMcpClientOAuthProvider } from './client-id-metadata.ts'
import {
	clearMcpOAuthRefreshSingleFlightForTests,
	createMcpOAuthRefreshFlightState,
	createMcpOAuthRefreshSingleFlightFetch,
	refreshTokenSurvivedRotation,
} from './oauth-refresh-single-flight.ts'
import { mcpOAuthRefreshTokenStorageKey } from './oauth-token-recovery.ts'

const tokenEndpoint = 'https://mediarss.example/oauth/token'

test('overlapping refresh grants share one redemption and later replays do too', async () => {
	const state = createMcpOAuthRefreshFlightState()
	let calls = 0
	let release: () => void = () => {}
	let markStarted: () => void = () => {}
	const started = new Promise<void>((resolve) => {
		markStarted = resolve
	})
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	const seen: Array<string> = []
	const base = async (_input: RequestInfo | URL, init?: RequestInit) => {
		calls += 1
		const params =
			init?.body instanceof URLSearchParams
				? init.body
				: new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
		seen.push(params.get('grant_type') ?? '')
		const presented = params.get('refresh_token')
		if (presented === 'rt-1') {
			markStarted()
			await gate
			return jsonResponse({
				access_token: 'at-2',
				refresh_token: 'rt-2',
				token_type: 'Bearer',
			})
		}
		if (presented === 'rt-dead') {
			return jsonResponse({ error: 'invalid_grant' }, 400)
		}
		return jsonResponse({
			access_token: 'at-other',
			refresh_token: 'rt-other-next',
			token_type: 'Bearer',
		})
	}
	let now = 1_000
	const refreshFetch = createMcpOAuthRefreshSingleFlightFetch(
		base as typeof fetch,
		{ now: () => now, ttlMs: 50, state },
	)

	const first = refreshFetch(tokenEndpoint, refreshInit('rt-1'))
	const second = refreshFetch(tokenEndpoint, refreshInit('rt-1'))
	await started
	expect(calls).toBe(1)
	release()
	const [leader, follower] = await Promise.all([first, second])
	expect(await leader.json()).toEqual({
		access_token: 'at-2',
		refresh_token: 'rt-2',
		token_type: 'Bearer',
	})
	expect(await follower.json()).toEqual({
		access_token: 'at-2',
		refresh_token: 'rt-2',
		token_type: 'Bearer',
	})

	const replay = await refreshFetch(tokenEndpoint, refreshInit('rt-1'))
	expect(calls).toBe(1)
	expect(await replay.json()).toMatchObject({ refresh_token: 'rt-2' })

	now = 1_060
	const afterTtl = await refreshFetch(tokenEndpoint, refreshInit('rt-1'))
	expect(calls).toBe(2)
	expect(await afterTtl.json()).toMatchObject({ refresh_token: 'rt-2' })

	await refreshFetch(tokenEndpoint, refreshInit('rt-other'))
	expect(calls).toBe(3)

	const authCode = {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code: 'one-time',
		}),
	}
	await refreshFetch(tokenEndpoint, authCode)
	await refreshFetch(tokenEndpoint, authCode)
	expect(calls).toBe(5)
	expect(seen.filter((grant) => grant === 'authorization_code')).toEqual([
		'authorization_code',
		'authorization_code',
	])

	const failed = await refreshFetch(tokenEndpoint, refreshInit('rt-dead'))
	expect(failed.status).toBe(400)
	const failedAgain = await refreshFetch(tokenEndpoint, refreshInit('rt-dead'))
	expect(failedAgain.status).toBe(400)
	expect(calls).toBe(7)

	let forwarded = ''
	const passFetch = createMcpOAuthRefreshSingleFlightFetch(
		(async (_input: RequestInfo | URL, init?: RequestInit) => {
			forwarded = typeof init?.body === 'string' ? init.body : ''
			return jsonResponse({ ok: true })
		}) as typeof fetch,
		{ state: createMcpOAuthRefreshFlightState() },
	)
	const rpc = await passFetch('https://mediarss.example/mcp', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{"method":"tools/list"}',
	})
	expect(rpc.ok).toBe(true)
	expect(forwarded).toBe('{"method":"tools/list"}')
})

test('a rotated refresh token survives a stale invalidate until that issued token is rejected', () => {
	const success = {
		presentedRefreshToken: 'rt-1',
		issuedRefreshToken: 'rt-2',
		at: 1_000,
	}
	expect(
		refreshTokenSurvivedRotation({
			storedRefreshToken: 'rt-1',
			successes: [success],
			failures: [],
			now: 1_500,
			ttlMs: 1_000,
		}),
	).toBe(true)
	expect(
		refreshTokenSurvivedRotation({
			storedRefreshToken: 'rt-2',
			successes: [success],
			failures: [],
			now: 1_500,
			ttlMs: 1_000,
		}),
	).toBe(true)
	expect(
		refreshTokenSurvivedRotation({
			storedRefreshToken: 'rt-2',
			successes: [success],
			failures: [{ refreshToken: 'rt-2', at: 1_200 }],
			now: 1_500,
			ttlMs: 1_000,
		}),
	).toBe(false)
	expect(
		refreshTokenSurvivedRotation({
			storedRefreshToken: 'rt-1',
			successes: [success],
			failures: [],
			now: 3_000,
			ttlMs: 1_000,
		}),
	).toBe(false)
	expect(
		refreshTokenSurvivedRotation({
			storedRefreshToken: null,
			successes: [success],
			failures: [],
			now: 1_500,
			ttlMs: 1_000,
		}),
	).toBe(false)
})

test('token invalidate keeps a refresh token that this isolate already rotated', async () => {
	clearMcpOAuthRefreshSingleFlightForTests()
	const refreshFetch = createMcpOAuthRefreshSingleFlightFetch((async () =>
		jsonResponse({
			access_token: 'at-2',
			refresh_token: 'rt-2',
			token_type: 'Bearer',
		})) as typeof fetch)
	const exchanged = await refreshFetch(tokenEndpoint, refreshInit('rt-1'))
	expect(exchanged.ok).toBe(true)

	const { storage, values } = createMemoryStorage()
	const provider = createMcpClientOAuthProvider(
		storage,
		'https://kody.codes/account/mcp-servers/oauth/callback',
	)
	provider.serverId = 'server-mediarss'
	provider.clientId = 'https://kody.codes/oauth/client-metadata.json'
	await provider.saveTokens({
		access_token: 'at-1',
		refresh_token: 'rt-1',
		token_type: 'Bearer',
	})
	await provider.invalidateCredentials('tokens')
	expect(await provider.tokens()).toMatchObject({ refresh_token: 'rt-1' })
	expect(values.get(mcpOAuthRefreshTokenStorageKey('server-mediarss'))).toEqual(
		{ refresh_token: 'rt-1' },
	)

	const rejected = createMcpOAuthRefreshSingleFlightFetch((async () =>
		jsonResponse({ error: 'invalid_grant' }, 400)) as typeof fetch)
	const failure = await rejected(tokenEndpoint, refreshInit('rt-2'))
	expect(failure.status).toBe(400)
	await provider.invalidateCredentials('tokens')
	expect(await provider.tokens()).toBeUndefined()
	expect(
		values.get(mcpOAuthRefreshTokenStorageKey('server-mediarss')),
	).toBeUndefined()
})

function refreshInit(refreshToken: string): RequestInit {
	return {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		}),
	}
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function createMemoryStorage() {
	const values = new Map<string, unknown>()
	const storage = {
		put: async (key: string, value: unknown) => {
			values.set(key, value)
		},
		get: async (key: string) => values.get(key),
		delete: async (key: string | Array<string>) => {
			for (const item of Array.isArray(key) ? key : [key]) {
				values.delete(item)
			}
		},
		list: async ({ prefix }: { prefix?: string } = {}) => {
			return new Map(
				[...values.entries()].filter(([key]) =>
					prefix ? key.startsWith(prefix) : true,
				),
			)
		},
	} as unknown as DurableObjectStorage
	return { storage, values }
}
