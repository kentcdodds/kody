import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { expect, test } from 'vitest'
import {
	authorizeOAuthClient,
	exchangeAuthorizationCode,
	loginToApp,
	mcpAccountRejectedMessage,
	readCookieHeader,
	readStringField,
	registerOAuthClient,
	usernameFromEmail,
} from './mcp-oauth-client.ts'

function readRequestBody(request: IncomingMessage) {
	return new Promise<string>((resolve, reject) => {
		const chunks: Array<Buffer> = []
		request.on('data', (chunk) => {
			chunks.push(chunk as Buffer)
		})
		request.on('end', () => {
			resolve(Buffer.concat(chunks).toString('utf8'))
		})
		request.on('error', reject)
	})
}

async function withMockOrigin(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
	run: (origin: string) => Promise<void>,
) {
	const server = createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('expected TCP address')
	}
	try {
		await run(`http://127.0.0.1:${address.port}`)
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) reject(error)
				else resolve()
			})
		})
	}
}

test('OAuth helpers log in, register a client, authorize, and exchange a code', async () => {
	expect(usernameFromEmail('me@kentcdodds.com')).toBe('me')
	expect(usernameFromEmail('')).toBe('preview-user')
	expect(readStringField({ client_id: 'cid' }, 'client_id')).toBe('cid')
	expect(() => readStringField({ client_id: '' }, 'client_id')).toThrow(
		/client_id/,
	)
	expect(mcpAccountRejectedMessage('403 email_verification_required')).toMatch(
		/does not mark email verified via D1/,
	)

	const requests: Array<string> = []
	await withMockOrigin(
		(request, response) => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1')
			requests.push(`${request.method ?? 'GET'} ${url.pathname}`)
			void readRequestBody(request)
				.then((rawBody) => {
					if (request.method === 'POST' && url.pathname === '/auth') {
						const body = JSON.parse(rawBody) as { mode?: string }
						if (body.mode === 'signup') {
							response.setHeader('Content-Type', 'application/json')
							response.end(JSON.stringify({ ok: true }))
							return
						}
						response.setHeader('Set-Cookie', 'kody_session=abc; Path=/')
						response.setHeader('Content-Type', 'application/json')
						response.end(JSON.stringify({ ok: true }))
						return
					}
					if (request.method === 'POST' && url.pathname === '/oauth/register') {
						response.setHeader('Content-Type', 'application/json')
						response.end(
							JSON.stringify({
								client_id: 'client-1',
								client_secret: 'secret-1',
							}),
						)
						return
					}
					if (
						request.method === 'POST' &&
						url.pathname === '/oauth/authorize'
					) {
						if (request.headers.cookie !== 'kody_session=abc') {
							response.statusCode = 401
							response.end('missing session')
							return
						}
						if (url.searchParams.get('client_id') !== 'client-1') {
							response.statusCode = 400
							response.end('missing client')
							return
						}
						if (!url.searchParams.get('resource')?.endsWith('/mcp')) {
							response.statusCode = 400
							response.end('missing resource')
							return
						}
						response.setHeader('Content-Type', 'application/json')
						response.end(
							JSON.stringify({
								redirectTo:
									'http://127.0.0.1/oauth/callback?code=auth-code-1&state=kody-mcp-e2e-state',
							}),
						)
						return
					}
					if (request.method === 'POST' && url.pathname === '/oauth/token') {
						const body = new URLSearchParams(rawBody)
						if (
							body.get('code') !== 'auth-code-1' ||
							body.get('client_id') !== 'client-1' ||
							body.get('client_secret') !== 'secret-1' ||
							!body.get('resource')?.endsWith('/mcp')
						) {
							response.statusCode = 400
							response.end('bad token request')
							return
						}
						response.setHeader('Content-Type', 'application/json')
						response.end(JSON.stringify({ access_token: 'token-1' }))
						return
					}
					response.statusCode = 404
					response.end('missing')
				})
				.catch((error) => {
					response.statusCode = 500
					response.end(error instanceof Error ? error.message : String(error))
				})
		},
		async (origin) => {
			const cookie = await loginToApp(origin, {
				email: 'me@kentcdodds.com',
				username: 'user-me',
				password: 'ilikecode',
			})
			expect(cookie).toBe('kody_session=abc')
			expect(
				readCookieHeader(
					new Response(null, {
						headers: { 'Set-Cookie': 'kody_session=abc; Path=/' },
					}),
				),
			).toBe('kody_session=abc')

			const client = await registerOAuthClient(origin, {
				clientName: 'Kody control-kody package-create',
			})
			expect(client).toEqual({
				clientId: 'client-1',
				clientSecret: 'secret-1',
				redirectUri: 'http://127.0.0.1/oauth/callback',
			})

			const code = await authorizeOAuthClient(origin, client, cookie)
			expect(code).toBe('auth-code-1')

			const token = await exchangeAuthorizationCode(origin, client, code)
			expect(token).toBe('token-1')
		},
	)
	expect(requests).toEqual([
		'POST /auth',
		'POST /auth',
		'POST /oauth/register',
		'POST /oauth/authorize',
		'POST /oauth/token',
	])

	await withMockOrigin(
		(_request, response) => {
			response.statusCode = 403
			response.setHeader('Content-Type', 'application/json')
			response.end(JSON.stringify({ error: 'email_verification_required' }))
		},
		async (origin) => {
			await expect(registerOAuthClient(origin)).rejects.toThrow(
				/\/oauth\/register failed with 403/,
			)
			await expect(
				loginToApp(origin, {
					email: 'nobody@example.com',
					username: 'nobody',
					password: 'ilikecode',
				}),
			).rejects.toThrow(/Failed to authenticate/)
		},
	)
})
