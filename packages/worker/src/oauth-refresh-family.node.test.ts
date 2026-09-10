import { expect, test } from 'vitest'
import {
	decideRefreshFamilyAction,
	forgetRefreshFamilyGrant,
	handleMcpOAuthTokenRequest,
	hashOAuthToken,
	mcpOAuthRefreshFamilyReplayKey,
	mcpOAuthRefreshFamilySnapshotKey,
	parseOAuthRefreshToken,
	type RefreshFamilyGrantIds,
	type RefreshFamilySnapshot,
} from './oauth-refresh-family.ts'

function snapshot(overrides: Partial<RefreshFamilySnapshot> = {}) {
	return {
		userId: 'user-1',
		grantId: 'grant-1',
		currentRefreshTokenHash: 'hash-rt2',
		refreshToken: 'user-1:grant-1:rt2',
		accessToken: 'user-1:grant-1:at2',
		accessExpiresAt: 2_000,
		tokenType: 'bearer',
		scope: 'profile email',
		resource: 'https://heykody.dev/mcp',
		...overrides,
	} satisfies RefreshFamilySnapshot
}

function grant(overrides: Partial<RefreshFamilyGrantIds> = {}) {
	return {
		currentRefreshTokenHash: 'hash-rt2',
		previousRefreshTokenHash: 'hash-rt1',
		...overrides,
	} satisfies RefreshFamilyGrantIds
}

test('refresh family keys and token parsing stay grant-scoped', async () => {
	expect(parseOAuthRefreshToken('user-1:grant-1:rt1')).toEqual({
		userId: 'user-1',
		grantId: 'grant-1',
	})
	expect(parseOAuthRefreshToken('not-a-token')).toBeNull()
	expect(parseOAuthRefreshToken('user-1:grant-1:')).toBeNull()
	expect(mcpOAuthRefreshFamilySnapshotKey('user-1', 'grant-1')).toBe(
		'derived-cache:v1:mcp-oauth-refresh-family:user-1:grant-1',
	)
	expect(mcpOAuthRefreshFamilyReplayKey('user-1', 'grant-1', 'abc')).toBe(
		'derived-cache:v1:mcp-oauth-refresh-replay:user-1:grant-1:abc',
	)
	expect(await hashOAuthToken('user-1:grant-1:rt1')).toMatch(/^[0-9a-f]{64}$/)
})

test('refresh family returns current tokens on previous reuse and rejects stale replay', () => {
	const current = snapshot()
	const family = grant()

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt1',
			grant: family,
			snapshot: current,
			replay: null,
		}),
	).toEqual({ kind: 'return-snapshot' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt1',
			grant: family,
			snapshot: current,
			replay: current,
		}),
	).toEqual({ kind: 'return-replay' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt2',
			grant: family,
			snapshot: current,
			replay: null,
		}),
	).toEqual({ kind: 'pass-through' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt0',
			grant: family,
			snapshot: current,
			replay: snapshot({
				currentRefreshTokenHash: 'hash-rt2',
				accessExpiresAt: 1_010,
			}),
		}),
	).toEqual({ kind: 'return-replay' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt1',
			grant: grant({ currentRefreshTokenHash: 'hash-rt3' }),
			snapshot: snapshot({ currentRefreshTokenHash: 'hash-rt2' }),
			replay: snapshot({ currentRefreshTokenHash: 'hash-rt2' }),
		}),
	).toEqual({ kind: 'pass-through' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt1',
			grant: null,
			snapshot: current,
			replay: current,
		}),
	).toEqual({ kind: 'pass-through' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-unknown',
			grant: family,
			snapshot: current,
			replay: null,
		}),
	).toEqual({ kind: 'pass-through' })
})

function refreshTokenRequest(refreshToken: string) {
	return new Request('https://heykody.dev/oauth/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		}),
	})
}

function mintedTokens(refreshToken: string, accessToken: string) {
	return {
		access_token: accessToken,
		refresh_token: refreshToken,
		token_type: 'bearer',
		expires_in: 3600,
		scope: 'profile email',
	}
}

function missingKvEnv() {
	return {
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		BUNDLE_ARTIFACTS_KV: {
			async get() {
				return null
			},
			async put() {
				return undefined
			},
		},
		OAUTH_KV: {
			async get() {
				return null
			},
		},
	} as unknown as Env
}

test('refresh family persist failures still return provider-minted tokens', async () => {
	const minted = {
		access_token: 'user-1:grant-1:at2',
		refresh_token: 'user-1:grant-1:rt2',
		token_type: 'bearer',
		expires_in: 3600,
		scope: 'profile email',
	}
	const { response } = await handleMcpOAuthTokenRequest({
		request: new Request('https://heykody.dev/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: 'user-1:grant-1:rt1',
			}),
		}),
		env: {
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
			BUNDLE_ARTIFACTS_KV: {
				async get() {
					return null
				},
				async put() {
					throw new Error('kv unavailable')
				},
			},
			OAUTH_KV: {
				async get() {
					return null
				},
			},
		} as unknown as Env,
		fetchProvider: async () =>
			new Response(JSON.stringify(minted), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
	})
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual(minted)
})

test('refresh family reuses isolate memory when KV still misses after the first rotation', async () => {
	const env = missingKvEnv()
	const first = mintedTokens('user-mem:grant-mem:rt2', 'user-mem:grant-mem:at2')
	let providerCalls = 0
	const fetchProvider = async () => {
		providerCalls += 1
		if (providerCalls === 1) {
			return new Response(JSON.stringify(first), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		}
		return new Response(JSON.stringify({ error: 'invalid_grant' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		})
	}

	const [left, right] = await Promise.all([
		handleMcpOAuthTokenRequest({
			request: refreshTokenRequest('user-mem:grant-mem:rt1'),
			env,
			fetchProvider,
		}),
		handleMcpOAuthTokenRequest({
			request: refreshTokenRequest('user-mem:grant-mem:rt1'),
			env,
			fetchProvider,
		}),
	])
	expect(left.response.status).toBe(200)
	expect(right.response.status).toBe(200)
	await expect(left.response.json()).resolves.toMatchObject({
		access_token: first.access_token,
		refresh_token: first.refresh_token,
	})
	await expect(right.response.json()).resolves.toMatchObject({
		access_token: first.access_token,
		refresh_token: first.refresh_token,
	})
	expect(providerCalls).toBe(1)

	const reused = await handleMcpOAuthTokenRequest({
		request: refreshTokenRequest('user-mem:grant-mem:rt1'),
		env,
		fetchProvider,
	})
	expect(reused.response.status).toBe(200)
	await expect(reused.response.json()).resolves.toMatchObject({
		access_token: first.access_token,
		refresh_token: first.refresh_token,
	})
	expect(providerCalls).toBe(1)
})

test('refresh family previous reuse does not wait for a current-token rotation', async () => {
	const env = missingKvEnv()
	const family = mintedTokens(
		'user-lock:grant-lock:rt2',
		'user-lock:grant-lock:at2',
	)
	const rotated = mintedTokens(
		'user-lock:grant-lock:rt3',
		'user-lock:grant-lock:at3',
	)
	let releaseCurrentRefresh = () => {}
	const currentRefreshHeld = new Promise<void>((resolve) => {
		releaseCurrentRefresh = resolve
	})
	let currentRefreshStarted = () => {}
	const currentRefreshEntered = new Promise<void>((resolve) => {
		currentRefreshStarted = resolve
	})
	const fetchProvider = async (request: Request) => {
		const formData = await request.clone().formData()
		const presented = formData.get('refresh_token')
		if (presented === 'user-lock:grant-lock:rt1') {
			return new Response(JSON.stringify(family), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		}
		if (presented === 'user-lock:grant-lock:rt2') {
			currentRefreshStarted()
			await currentRefreshHeld
			return new Response(JSON.stringify(rotated), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		}
		return new Response(JSON.stringify({ error: 'invalid_grant' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		})
	}

	const seeded = await handleMcpOAuthTokenRequest({
		request: refreshTokenRequest('user-lock:grant-lock:rt1'),
		env,
		fetchProvider,
	})
	expect(seeded.response.status).toBe(200)
	await expect(seeded.response.json()).resolves.toEqual(family)

	const currentRefresh = handleMcpOAuthTokenRequest({
		request: refreshTokenRequest('user-lock:grant-lock:rt2'),
		env,
		fetchProvider,
	})
	await currentRefreshEntered
	const previousReuse = await handleMcpOAuthTokenRequest({
		request: refreshTokenRequest('user-lock:grant-lock:rt1'),
		env,
		fetchProvider,
	})
	expect(previousReuse.response.status).toBe(200)
	await expect(previousReuse.response.json()).resolves.toMatchObject({
		access_token: family.access_token,
		refresh_token: family.refresh_token,
	})
	releaseCurrentRefresh()
	const currentRefreshResult = await currentRefresh
	expect(currentRefreshResult.response.status).toBe(200)
	await expect(currentRefreshResult.response.json()).resolves.toEqual(rotated)
})

test('refresh family isolate memory does not survive grant revoke', async () => {
	const env = missingKvEnv()
	const family = mintedTokens(
		'user-rev:grant-rev:rt2',
		'user-rev:grant-rev:at2',
	)
	let providerCalls = 0
	const fetchProvider = async () => {
		providerCalls += 1
		if (providerCalls === 1) {
			return new Response(JSON.stringify(family), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		}
		return new Response(JSON.stringify({ error: 'invalid_grant' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		})
	}

	const seeded = await handleMcpOAuthTokenRequest({
		request: refreshTokenRequest('user-rev:grant-rev:rt1'),
		env,
		fetchProvider,
	})
	expect(seeded.response.status).toBe(200)
	await forgetRefreshFamilyGrant('user-rev', 'grant-rev')

	const afterRevoke = await handleMcpOAuthTokenRequest({
		request: refreshTokenRequest('user-rev:grant-rev:rt1'),
		env,
		fetchProvider,
	})
	expect(afterRevoke.response.status).toBe(400)
	await expect(afterRevoke.response.json()).resolves.toEqual({
		error: 'invalid_grant',
	})
	expect(providerCalls).toBe(2)
})

test('refresh family forget wins over an in-flight persist', async () => {
	const env = missingKvEnv()
	const family = mintedTokens(
		'user-race:grant-race:rt2',
		'user-race:grant-race:at2',
	)
	const rotated = mintedTokens(
		'user-race:grant-race:rt3',
		'user-race:grant-race:at3',
	)
	let releaseCurrentRefresh = () => {}
	const currentRefreshHeld = new Promise<void>((resolve) => {
		releaseCurrentRefresh = resolve
	})
	let currentRefreshStarted = () => {}
	const currentRefreshEntered = new Promise<void>((resolve) => {
		currentRefreshStarted = resolve
	})
	let seededFirstRefresh = false
	let rotatedCurrentOnce = false
	const fetchProvider = async (request: Request) => {
		const formData = await request.clone().formData()
		const presented = formData.get('refresh_token')
		if (presented === 'user-race:grant-race:rt1' && !seededFirstRefresh) {
			seededFirstRefresh = true
			return new Response(JSON.stringify(family), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		}
		if (presented === 'user-race:grant-race:rt2' && !rotatedCurrentOnce) {
			rotatedCurrentOnce = true
			currentRefreshStarted()
			await currentRefreshHeld
			return new Response(JSON.stringify(rotated), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		}
		return new Response(JSON.stringify({ error: 'invalid_grant' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		})
	}

	const seeded = await handleMcpOAuthTokenRequest({
		request: refreshTokenRequest('user-race:grant-race:rt1'),
		env,
		fetchProvider,
	})
	expect(seeded.response.status).toBe(200)

	const currentRefresh = handleMcpOAuthTokenRequest({
		request: refreshTokenRequest('user-race:grant-race:rt2'),
		env,
		fetchProvider,
	})
	await currentRefreshEntered
	const forget = forgetRefreshFamilyGrant('user-race', 'grant-race')
	releaseCurrentRefresh()
	const currentRefreshResult = await currentRefresh
	expect(currentRefreshResult.response.status).toBe(200)
	await forget

	const afterRevoke = await handleMcpOAuthTokenRequest({
		request: refreshTokenRequest('user-race:grant-race:rt2'),
		env,
		fetchProvider,
	})
	expect(afterRevoke.response.status).toBe(400)
	await expect(afterRevoke.response.json()).resolves.toEqual({
		error: 'invalid_grant',
	})
})
