import { expect, test } from 'vitest'
import {
	isMcpOAuthRefreshTokenGrantBody,
	readRefreshTokenFromTokenRequestBody,
	releaseMcpOAuthRefreshCoalesce,
	wrapFetchForMcpOAuthRefreshCoalesce,
} from './oauth-refresh-coalesce.ts'

test('refresh-token grant body detection and token extraction', () => {
	const body = 'grant_type=refresh_token&refresh_token=rt-1&client_id=cimd'
	expect(isMcpOAuthRefreshTokenGrantBody(body)).toBe(true)
	expect(isMcpOAuthRefreshTokenGrantBody('grant_type=authorization_code')).toBe(
		false,
	)
	expect(readRefreshTokenFromTokenRequestBody(body)).toBe('rt-1')
	expect(readRefreshTokenFromTokenRequestBody(null)).toBeNull()
})

test('concurrent refresh_token POSTs with the same token share one HTTP exchange', async () => {
	const scope = {}
	let posts = 0
	const { promise: releaseFirst, resolve: unlockFirst } =
		Promise.withResolvers<void>()
	const { promise: firstStarted, resolve: markFirstStarted } =
		Promise.withResolvers<void>()

	const baseFetch: typeof fetch = async (_input, _init) => {
		posts += 1
		markFirstStarted()
		await releaseFirst
		return new Response(
			JSON.stringify({
				access_token: 'at-rotated',
				refresh_token: 'rt-rotated',
				token_type: 'Bearer',
				expires_in: 3600,
			}),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			},
		)
	}

	const coalesce = wrapFetchForMcpOAuthRefreshCoalesce(scope, baseFetch)
	const body = 'grant_type=refresh_token&refresh_token=rt-parent'
	const first = coalesce('https://auth.example/token', {
		method: 'POST',
		body,
	})
	await firstStarted
	const second = coalesce('https://auth.example/token', {
		method: 'POST',
		body,
	})
	unlockFirst()
	const [a, b] = await Promise.all([first, second])
	expect(posts).toBe(1)
	expect(a.status).toBe(200)
	expect(b.status).toBe(200)
	expect(await a.json()).toEqual({
		access_token: 'at-rotated',
		refresh_token: 'rt-rotated',
		token_type: 'Bearer',
		expires_in: 3600,
	})
	expect(await b.json()).toEqual({
		access_token: 'at-rotated',
		refresh_token: 'rt-rotated',
		token_type: 'Bearer',
		expires_in: 3600,
	})
})

test('distinct refresh tokens and non-refresh grants are not coalesced', async () => {
	const scope = {}
	let posts = 0
	const baseFetch: typeof fetch = async () => {
		posts += 1
		return new Response('{}', { status: 200 })
	}
	const coalesce = wrapFetchForMcpOAuthRefreshCoalesce(scope, baseFetch)
	await Promise.all([
		coalesce('https://auth.example/token', {
			method: 'POST',
			body: 'grant_type=refresh_token&refresh_token=rt-a',
		}),
		coalesce('https://auth.example/token', {
			method: 'POST',
			body: 'grant_type=refresh_token&refresh_token=rt-b',
		}),
		coalesce('https://auth.example/token', {
			method: 'POST',
			body: 'grant_type=authorization_code&code=x',
		}),
	])
	expect(posts).toBe(3)
})

test('a second refresh with the same parent token reuses the completed response until release', async () => {
	const scope = {}
	let posts = 0
	const baseFetch: typeof fetch = async () => {
		posts += 1
		return new Response(
			JSON.stringify({
				access_token: 'at-1',
				refresh_token: 'rt-2',
				token_type: 'Bearer',
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		)
	}
	const coalesce = wrapFetchForMcpOAuthRefreshCoalesce(scope, baseFetch)
	const body = 'grant_type=refresh_token&refresh_token=rt-1'
	const first = await coalesce('https://auth.example/token', {
		method: 'POST',
		body,
	})
	expect(posts).toBe(1)
	expect(await first.json()).toMatchObject({ refresh_token: 'rt-2' })

	// Gap before saveTokens: another 401 must not spend rt-1 again.
	const second = await coalesce('https://auth.example/token', {
		method: 'POST',
		body,
	})
	expect(posts).toBe(1)
	expect(await second.json()).toMatchObject({ refresh_token: 'rt-2' })

	releaseMcpOAuthRefreshCoalesce(scope)
	await coalesce('https://auth.example/token', { method: 'POST', body })
	expect(posts).toBe(2)
})
