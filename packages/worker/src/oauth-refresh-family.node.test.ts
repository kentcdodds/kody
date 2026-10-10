import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import * as Sentry from '@sentry/cloudflare'
import { expect, test, vi } from 'vitest'
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
		userId: ownerIdFromStored('user-1'),
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
		userId: ownerIdFromStored('user-1'),
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
	const rows: Array<
		[
			presentedHash: string,
			grantIds: RefreshFamilyGrantIds | null,
			replay: RefreshFamilySnapshot | null,
			kind: string,
		]
	> = [
		['hash-rt1', family, null, 'return-snapshot'],
		['hash-rt1', family, current, 'return-replay'],
		['hash-rt2', family, null, 'pass-through'],
		['hash-rt0', family, snapshot({ accessExpiresAt: 1_010 }), 'return-replay'],
		[
			'hash-rt1',
			grant({ currentRefreshTokenHash: 'hash-rt3' }),
			current,
			'pass-through',
		],
		['hash-rt1', null, current, 'pass-through'],
		['hash-unknown', family, null, 'pass-through'],
	]
	expect(
		rows.map(([presentedHash, grantIds, replay]) =>
			decideRefreshFamilyAction({
				presentedHash,
				grant: grantIds,
				snapshot: current,
				replay,
			}),
		),
	).toEqual(rows.map(([, , , kind]) => ({ kind })))
})

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

const invalidGrant = () => jsonResponse({ error: 'invalid_grant' }, 400)

function mintedTokens(prefix: string, rotation: number) {
	return {
		access_token: `${prefix}:at${rotation}`,
		refresh_token: `${prefix}:rt${rotation}`,
		token_type: 'bearer',
		expires_in: 3600,
		scope: 'profile email',
	}
}

function kvEnv(put: () => Promise<undefined> = async () => undefined): Env {
	return {
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		BUNDLE_ARTIFACTS_KV: { get: async () => null, put },
		OAUTH_KV: { get: async () => null },
	} as unknown as Env
}

function refresher(
	env: Env,
	fetchProvider: (request: Request) => Promise<Response>,
) {
	return (refreshToken: string) =>
		handleMcpOAuthTokenRequest({
			request: new Request('https://heykody.dev/oauth/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: refreshToken,
				}),
			}),
			env,
			fetchProvider,
		})
}

async function presentedRefreshToken(request: Request) {
	return (await request.clone().formData()).get('refresh_token')
}

function gate() {
	let open = () => {}
	const opened = new Promise<void>((resolve) => {
		open = resolve
	})
	return { open, opened }
}

test('refresh family persist failures still return provider-minted tokens', async () => {
	const captureException = vi.spyOn(Sentry, 'captureException')
	const unexpectedPersistError = new Error('kv unavailable')
	const cases = [
		['grant-kv', new Error('KV PUT failed: 500 Internal Server Error')],
		['grant-other', unexpectedPersistError],
	] as const

	for (const [grantId, putError] of cases) {
		const minted = mintedTokens(`user-persist:${grantId}`, 2)
		const { response } = await refresher(
			kvEnv(async () => {
				throw putError
			}),
			async () => jsonResponse(minted),
		)(`user-persist:${grantId}:rt1`)
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual(minted)
		if (putError === unexpectedPersistError) {
			expect(captureException).toHaveBeenCalledWith(unexpectedPersistError)
		} else {
			expect(captureException).not.toHaveBeenCalled()
		}
	}
	captureException.mockRestore()
})

test('refresh family reuses isolate memory when KV still misses after the first rotation', async () => {
	const first = mintedTokens('user-mem:grant-mem', 2)
	let providerCalls = 0
	const refresh = refresher(kvEnv(), async () => {
		providerCalls += 1
		return providerCalls === 1 ? jsonResponse(first) : invalidGrant()
	})
	const firstTokens = {
		access_token: first.access_token,
		refresh_token: first.refresh_token,
	}

	const concurrent = await Promise.all([
		refresh('user-mem:grant-mem:rt1'),
		refresh('user-mem:grant-mem:rt1'),
	])
	const reused = await refresh('user-mem:grant-mem:rt1')
	for (const { response } of [...concurrent, reused]) {
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toMatchObject(firstTokens)
	}
	expect(providerCalls).toBe(1)
})

test('refresh family previous reuse does not wait for a current-token rotation', async () => {
	const family = mintedTokens('user-lock:grant-lock', 2)
	const rotated = mintedTokens('user-lock:grant-lock', 3)
	const currentRefreshHeld = gate()
	const currentRefreshEntered = gate()
	const refresh = refresher(kvEnv(), async (request) => {
		const presented = await presentedRefreshToken(request)
		if (presented === 'user-lock:grant-lock:rt1') return jsonResponse(family)
		if (presented === 'user-lock:grant-lock:rt2') {
			currentRefreshEntered.open()
			await currentRefreshHeld.opened
			return jsonResponse(rotated)
		}
		return invalidGrant()
	})

	const seeded = await refresh('user-lock:grant-lock:rt1')
	expect(seeded.response.status).toBe(200)
	await expect(seeded.response.json()).resolves.toEqual(family)

	const currentRefresh = refresh('user-lock:grant-lock:rt2')
	await currentRefreshEntered.opened
	const previousReuse = await refresh('user-lock:grant-lock:rt1')
	expect(previousReuse.response.status).toBe(200)
	await expect(previousReuse.response.json()).resolves.toMatchObject({
		access_token: family.access_token,
		refresh_token: family.refresh_token,
	})
	currentRefreshHeld.open()
	const currentRefreshResult = await currentRefresh
	expect(currentRefreshResult.response.status).toBe(200)
	await expect(currentRefreshResult.response.json()).resolves.toEqual(rotated)
})

test('refresh family isolate memory does not survive grant revoke', async () => {
	let providerCalls = 0
	const refresh = refresher(kvEnv(), async () => {
		providerCalls += 1
		return providerCalls === 1
			? jsonResponse(mintedTokens('user-rev:grant-rev', 2))
			: invalidGrant()
	})

	expect((await refresh('user-rev:grant-rev:rt1')).response.status).toBe(200)
	await forgetRefreshFamilyGrant('user-rev', 'grant-rev')

	const afterRevoke = await refresh('user-rev:grant-rev:rt1')
	expect(afterRevoke.response.status).toBe(400)
	await expect(afterRevoke.response.json()).resolves.toEqual({
		error: 'invalid_grant',
	})
	expect(providerCalls).toBe(2)
})

test('refresh family forget wins over an in-flight persist', async () => {
	const currentRefreshHeld = gate()
	const currentRefreshEntered = gate()
	let seededFirstRefresh = false
	let rotatedCurrentOnce = false
	const refresh = refresher(kvEnv(), async (request) => {
		const presented = await presentedRefreshToken(request)
		if (presented === 'user-race:grant-race:rt1' && !seededFirstRefresh) {
			seededFirstRefresh = true
			return jsonResponse(mintedTokens('user-race:grant-race', 2))
		}
		if (presented === 'user-race:grant-race:rt2' && !rotatedCurrentOnce) {
			rotatedCurrentOnce = true
			currentRefreshEntered.open()
			await currentRefreshHeld.opened
			return jsonResponse(mintedTokens('user-race:grant-race', 3))
		}
		return invalidGrant()
	})

	expect((await refresh('user-race:grant-race:rt1')).response.status).toBe(200)

	const currentRefresh = refresh('user-race:grant-race:rt2')
	await currentRefreshEntered.opened
	const forget = forgetRefreshFamilyGrant('user-race', 'grant-race')
	const reuseDuringLockWait = refresh('user-race:grant-race:rt1')
	const reuseWhileLocked = await Promise.race([
		reuseDuringLockWait.then((result) => ({ kind: 'returned', result })),
		new Promise<{ kind: 'waiting' }>((resolve) => {
			setTimeout(() => resolve({ kind: 'waiting' }), 20)
		}),
	])
	expect(reuseWhileLocked.kind).toBe('waiting')
	currentRefreshHeld.open()
	expect((await currentRefresh).response.status).toBe(200)
	await forget

	for (const attempt of [
		() => reuseDuringLockWait,
		() => refresh('user-race:grant-race:rt2'),
	]) {
		const { response } = await attempt()
		expect(response.status).toBe(400)
		await expect(response.json()).resolves.toEqual({ error: 'invalid_grant' })
	}
})
