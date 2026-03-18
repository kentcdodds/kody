import { expect, test, type APIRequestContext } from '@playwright/test'
import { createServer } from 'node:http'
import getPort from 'get-port'

function toBase64Url(bytes: Uint8Array) {
	return Buffer.from(bytes)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '')
}

function createCodeVerifier() {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

async function createCodeChallenge(codeVerifier: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(codeVerifier),
	)
	return toBase64Url(new Uint8Array(digest))
}

async function createUser(request: APIRequestContext) {
	const user = {
		email: `oauth-ui-${crypto.randomUUID()}@example.com`,
		password: `pw-${crypto.randomUUID()}`,
	}
	const response = await request.post('/auth', {
		data: { ...user, mode: 'signup' },
		headers: { 'Content-Type': 'application/json' },
	})
	if (!response.ok()) {
		throw new Error(`Failed to create user (${response.status()}).`)
	}
	return user
}

async function registerOAuthClient(
	request: APIRequestContext,
	redirectUri: string,
) {
	const response = await request.post('/oauth/register', {
		data: {
			client_name: 'oauth-ui-playwright-client',
			redirect_uris: [redirectUri],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'client_secret_post',
		},
		headers: { 'Content-Type': 'application/json' },
	})
	if (!response.ok()) {
		throw new Error(`Failed to register OAuth client (${response.status()}).`)
	}
	const payload = (await response.json()) as {
		client_id?: unknown
	}
	if (typeof payload.client_id !== 'string') {
		throw new Error('OAuth client registration response missing client_id.')
	}
	return payload.client_id
}

async function createLoopbackCallbackServer() {
	const port = await getPort({ host: '127.0.0.1' })
	let resolveCallback: ((url: URL) => void) | null = null
	const callbackPromise = new Promise<URL>((resolve) => {
		resolveCallback = resolve
	})

	const server = createServer((req, res) => {
		const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
		resolveCallback?.(requestUrl)
		resolveCallback = null
		res.statusCode = 200
		res.setHeader('Content-Type', 'text/plain; charset=utf-8')
		res.end('oauth callback received')
	})

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, '127.0.0.1', () => {
			server.off('error', reject)
			resolve()
		})
	})

	return {
		redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
		waitForCallback: () => callbackPromise,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error)
						return
					}
					resolve()
				})
			})
		},
	}
}

test('oauth authorize page accepts valid credentials for logged-out user', async ({
	baseURL,
	page,
}) => {
	if (!baseURL) {
		throw new Error('Playwright baseURL is required for OAuth test.')
	}

	const user = await createUser(page.request)
	const redirectUri = `${baseURL}/oauth/callback`
	const clientId = await registerOAuthClient(page.request, redirectUri)
	const codeVerifier = createCodeVerifier()
	const codeChallenge = await createCodeChallenge(codeVerifier)
	await page.context().clearCookies()

	const authorizeParams = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: redirectUri,
		scope: 'profile email',
		state: 'playwright-oauth-state',
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
	})

	await page.goto(`/oauth/authorize?${authorizeParams.toString()}`)
	await expect(
		page.getByRole('heading', { name: 'Authorize access' }),
	).toBeVisible()
	await expect(page.getByLabel('Email')).toBeVisible()

	await page.getByLabel('Email').fill(user.email)
	await page.getByLabel('Password').fill(user.password)
	await page.getByRole('button', { name: 'Authorize' }).click()

	await expect(page).toHaveURL(/\/oauth\/callback\?/)
	const callbackUrl = new URL(page.url())
	expect(callbackUrl.searchParams.get('code')).toBeTruthy()
	await expect(
		page.getByRole('heading', { name: 'OAuth callback' }),
	).toBeVisible()
})

test('oauth authorize redirects to loopback callback with code after login', async ({
	page,
}) => {
	const callbackServer = await createLoopbackCallbackServer()
	try {
		const user = await createUser(page.request)
		const clientId = await registerOAuthClient(
			page.request,
			callbackServer.redirectUri,
		)
		const codeVerifier = createCodeVerifier()
		const codeChallenge = await createCodeChallenge(codeVerifier)
		await page.context().clearCookies()

		const authorizeParams = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: callbackServer.redirectUri,
			scope: 'profile email',
			state: 'playwright-oauth-loopback',
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
		})

		await page.goto(`/oauth/authorize?${authorizeParams.toString()}`)
		await expect(page.getByLabel('Email')).toBeVisible()
		await page.getByLabel('Email').fill(user.email)
		await page.getByLabel('Password').fill(user.password)
		await page.getByRole('button', { name: 'Authorize' }).click()

		const callbackRequest = await callbackServer.waitForCallback()
		expect(callbackRequest.searchParams.get('code')).toBeTruthy()
		expect(callbackRequest.searchParams.get('state')).toBe(
			'playwright-oauth-loopback',
		)
	} finally {
		await callbackServer.close()
	}
})

test('oauth login link preserves authorize params through login', async ({
	page,
}) => {
	const callbackServer = await createLoopbackCallbackServer()
	try {
		const user = await createUser(page.request)
		const clientId = await registerOAuthClient(
			page.request,
			callbackServer.redirectUri,
		)
		const codeVerifier = createCodeVerifier()
		const codeChallenge = await createCodeChallenge(codeVerifier)
		await page.context().clearCookies()

		const authorizeParams = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: callbackServer.redirectUri,
			scope: 'profile email',
			state: 'playwright-oauth-link-login',
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
		})
		const authorizePath = `/oauth/authorize?${authorizeParams.toString()}`
		await page.goto(authorizePath)
		await page.getByRole('link', { name: 'Login' }).click()
		await expect(page).toHaveURL(/\/login/)

		await page.getByLabel('Email').fill(user.email)
		await page.getByLabel('Password').fill(user.password)
		await page.getByRole('button', { name: 'Sign in' }).click()

		await expect(page).toHaveURL(new RegExp(`/oauth/authorize\\?`))
		await expect(
			page.getByRole('button', { name: 'Approve connection' }),
		).toBeVisible()
	} finally {
		await callbackServer.close()
	}
})
