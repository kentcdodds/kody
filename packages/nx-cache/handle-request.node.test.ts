import { expect, test } from 'vitest'

import { handleNxCacheRequest, parseCacheHash } from './handle-request.ts'
import { createMemoryCacheStore } from './memory-store.ts'
import { type NxCacheEnv } from './nx-cache-types.ts'

const ACCESS_TOKEN = 'test-nx-cache-token'
const HASH = '0123456789abcdef0123456789abcdef'

function env(overrides: { token?: string; commit?: string } = {}) {
	return {
		CACHE_ACCESS_TOKEN: overrides.token ?? ACCESS_TOKEN,
		BUILD_COMMIT: overrides.commit ?? 'commit-sha',
	}
}

async function handle(
	request: Request,
	store = createMemoryCacheStore(),
	environment: Pick<NxCacheEnv, 'CACHE_ACCESS_TOKEN' | 'BUILD_COMMIT'> = env(),
) {
	return handleNxCacheRequest(request, environment, store)
}

function authorized(method: string, path: string, body?: ArrayBuffer) {
	return new Request(`https://nx-cache.kody.codes${path}`, {
		method,
		headers: {
			authorization: `Bearer ${ACCESS_TOKEN}`,
			...(body
				? {
						'content-type': 'application/octet-stream',
						'content-length': String(body.byteLength),
					}
				: {}),
		},
		body: body ?? null,
	})
}

test('parseCacheHash accepts Nx-style hex hashes and rejects path escape', () => {
	expect(parseCacheHash(`/v1/cache/${HASH}`)).toBe(HASH)
	expect(parseCacheHash('/v1/cache/../secrets')).toBeNull()
	expect(parseCacheHash('/v1/cache/not-hex')).toBeNull()
	expect(parseCacheHash('/v1/cache/abcd')).toBeNull()
	expect(parseCacheHash('/health')).toBeNull()
})

test('GET /health is unauthenticated and reports the deploy commit', async () => {
	const response = await handle(
		new Request('https://nx-cache.kody.codes/health'),
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		commit: 'commit-sha',
	})
})

test('cache reads and writes require a bearer token', async () => {
	const missing = await handle(
		new Request(`https://nx-cache.kody.codes/v1/cache/${HASH}`),
	)
	expect(missing.status).toBe(401)

	const wrong = await handle(
		new Request(`https://nx-cache.kody.codes/v1/cache/${HASH}`, {
			headers: { authorization: 'Bearer wrong-token' },
		}),
	)
	expect(wrong.status).toBe(401)
})

test('unconfigured access token fails closed', async () => {
	const blank = await handle(
		authorized('GET', `/v1/cache/${HASH}`),
		createMemoryCacheStore(),
		env({ token: '   ' }),
	)
	expect(blank.status).toBe(503)

	const missing = await handle(
		authorized('GET', `/v1/cache/${HASH}`),
		createMemoryCacheStore(),
		{ CACHE_ACCESS_TOKEN: undefined, BUILD_COMMIT: 'commit-sha' },
	)
	expect(missing.status).toBe(503)
})

test('PUT then GET round-trips an artifact and PUT is create-only', async () => {
	const store = createMemoryCacheStore()
	const artifact = new TextEncoder().encode('nx-cache-artifact').buffer

	const created = await handle(
		authorized('PUT', `/v1/cache/${HASH}`, artifact),
		store,
	)
	expect(created.status).toBe(200)

	const replay = await handle(
		authorized('PUT', `/v1/cache/${HASH}`, artifact),
		store,
	)
	expect(replay.status).toBe(409)

	const fetched = await handle(authorized('GET', `/v1/cache/${HASH}`), store)
	expect(fetched.status).toBe(200)
	expect(fetched.headers.get('content-type')).toBe('application/octet-stream')
	expect(await fetched.text()).toBe('nx-cache-artifact')
})

test('GET returns 404 for a missing hash', async () => {
	const response = await handle(authorized('GET', `/v1/cache/${HASH}`))
	expect(response.status).toBe(404)
})

test('PUT rejects missing Content-Length and oversized artifacts', async () => {
	const missingLength = await handle(
		new Request(`https://nx-cache.kody.codes/v1/cache/${HASH}`, {
			method: 'PUT',
			headers: {
				authorization: `Bearer ${ACCESS_TOKEN}`,
				'content-type': 'application/octet-stream',
			},
			// Stream bodies do not get an automatic Content-Length.
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]))
					controller.close()
				},
			}),
			duplex: 'half',
		} as RequestInit),
	)
	expect(missingLength.status).toBe(400)

	const tooLarge = await handle(
		new Request(`https://nx-cache.kody.codes/v1/cache/${HASH}`, {
			method: 'PUT',
			headers: {
				authorization: `Bearer ${ACCESS_TOKEN}`,
				'content-type': 'application/octet-stream',
				'content-length': String(100 * 1024 * 1024 + 1),
			},
			body: new Uint8Array([1]),
		}),
	)
	expect(tooLarge.status).toBe(413)
})
