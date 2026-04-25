import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
import getPort from 'get-port'
import {
	captureOutput,
	nodeBin,
	spawnProcess,
	stopProcess,
} from '#mcp/test-process.ts'

const projectRoot = process.cwd()
const primaryUserEmail = 'me@kentcdodds.com'
const testUserPassword = 'secret'
const localhost = '127.0.0.1'
const defaultWaitTimeoutMs = process.env.CI ? 60_000 : 45_000
const maxPortBindRetries = 5

type TestUser = {
	email: string
	password: string
}

type OAuthClientRegistration = {
	clientId: string
	clientSecret: string
	redirectUri: string
}

type TestCallToolParams = CallToolRequest['params'] & {
	headers?: Record<string, string>
}

type ConnectedTestClient = {
	callTool(params: TestCallToolParams): ReturnType<Client['callTool']>
	listTools(): ReturnType<Client['listTools']>
}

export async function createTestDatabase() {
	const persistDir = await mkdtemp(path.join(tmpdir(), 'kody-mcp-e2e-'))
	const user = {
		email: primaryUserEmail,
		password: testUserPassword,
	} satisfies TestUser

	return {
		persistDir,
		user,
		async [Symbol.asyncDispose]() {
			await rm(persistDir, { recursive: true, force: true })
		},
	}
}

export async function startDevServer(persistDir: string) {
	await applyMigrations(persistDir)
	for (let attempt = 1; attempt <= maxPortBindRetries; attempt++) {
		const mockCloudflarePort = await getPort({ host: localhost })
		const mockCloudflareOrigin = `http://${localhost}:${mockCloudflarePort}`
		const mockCloudflareToken = `mock-cloudflare-${crypto.randomUUID()}`
		const mockCloudflareProc = spawnProcess({
			cmd: [
				nodeBin,
				'--env-file=packages/worker/.env',
				'./wrangler-env.ts',
				'dev',
				'--local',
				'--config',
				'packages/mock-servers/cloudflare/wrangler.jsonc',
				'--port',
				String(mockCloudflarePort),
				'--ip',
				localhost,
				'--show-interactive-dev-session=false',
				'--log-level',
				'error',
				'--var',
				`MOCK_API_TOKEN:${mockCloudflareToken}`,
			],
			cwd: projectRoot,
			env: {
				...process.env,
				CLOUDFLARE_ENV: 'test',
			},
		})
		const getMockCloudflareStdout = captureOutput(mockCloudflareProc.stdout)
		const getMockCloudflareStderr = captureOutput(mockCloudflareProc.stderr)

		try {
			await waitForUrlReady(
				new URL('/__mocks/meta', mockCloudflareOrigin),
				mockCloudflareProc.exited,
				getMockCloudflareStdout,
				getMockCloudflareStderr,
			)
		} catch (error) {
			await stopProcess(mockCloudflareProc).catch(() => undefined)
			if (isPortAlreadyInUseError(error) && attempt < maxPortBindRetries) {
				continue
			}
			throw error
		}

		const port = await getPort({ host: localhost })
		const origin = `http://${localhost}:${port}`
		const proc = spawnProcess({
			cmd: [
				nodeBin,
				'--env-file=packages/worker/.env',
				'./wrangler-env.ts',
				'dev',
				'--local',
				'--persist-to',
				persistDir,
				'--port',
				String(port),
				'--ip',
				localhost,
				'--show-interactive-dev-session=false',
				'--log-level',
				'error',
				'--var',
				`CLOUDFLARE_API_BASE_URL:${mockCloudflareOrigin}`,
				'--var',
				`CLOUDFLARE_API_TOKEN:${mockCloudflareToken}`,
				'--var',
				'CLOUDFLARE_ACCOUNT_ID:cf_account_mock_123',
			],
			cwd: projectRoot,
			env: {
				...process.env,
				CLOUDFLARE_ENV: 'test',
			},
		})
		const getStdout = captureOutput(proc.stdout)
		const getStderr = captureOutput(proc.stderr)

		try {
			await waitForServerReady(origin, proc.exited, getStdout, getStderr)
			return {
				origin,
				async [Symbol.asyncDispose]() {
					await Promise.allSettled([
						stopProcess(proc),
						stopProcess(mockCloudflareProc),
					])
				},
			}
		} catch (error) {
			await stopProcess(mockCloudflareProc).catch(() => undefined)
			await stopProcess(proc).catch(() => undefined)
			if (isPortAlreadyInUseError(error) && attempt < maxPortBindRetries) {
				continue
			}
			throw error
		}
	}

	throw new Error('Failed to start MCP test dev servers after multiple retries.')
}

function isPortAlreadyInUseError(error: unknown) {
	return (
		error instanceof Error &&
		error.message.includes('Address already in use')
	)
}

export async function loginToApp(origin: string, user: TestUser) {
	const signupResponse = await authenticateAppUser(origin, user, 'signup')
	if (signupResponse.ok) {
		return readCookieHeader(signupResponse)
	}

	const loginResponse = await authenticateAppUser(origin, user, 'login')
	if (!loginResponse.ok) {
		const signupBody = await signupResponse.text()
		const loginBody = await loginResponse.text()
		throw new Error(
			`Failed to authenticate test user.\nSignup: ${signupResponse.status} ${signupBody}\nLogin: ${loginResponse.status} ${loginBody}`,
		)
	}

	return readCookieHeader(loginResponse)
}

export async function createMcpClient(
	origin: string,
	user: TestUser,
	extraHeaders?: Record<string, string>,
) {
	const cookieHeader = await loginToApp(origin, user)
	const clientRegistration = await registerOAuthClient(origin)
	const code = await authorizeOAuthClient(
		origin,
		clientRegistration,
		cookieHeader,
	)
	const accessToken = await exchangeAuthorizationCode(
		origin,
		clientRegistration,
		code,
	)
	const defaultHeaders: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
	}

	const defaultConnection = await connectMcpClient(origin, {
		...defaultHeaders,
		...extraHeaders,
	})

	const client: ConnectedTestClient = {
		listTools() {
			return defaultConnection.client.listTools()
		},
		async callTool(params) {
			const { headers, ...callToolParams } = params
			if (!headers || Object.keys(headers).length === 0) {
				return defaultConnection.client.callTool(callToolParams)
			}

			const overrideConnection = await connectMcpClient(origin, {
				...defaultHeaders,
				...extraHeaders,
				...headers,
			})
			try {
				return await overrideConnection.client.callTool(callToolParams)
			} finally {
				await closeMcpConnection(overrideConnection)
			}
		},
	}

	return {
		client,
		async [Symbol.asyncDispose]() {
			await closeMcpConnection(defaultConnection)
		},
	}
}

export async function fetchJson<T = Record<string, unknown>>(
	origin: string,
	pathname: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetch(new URL(pathname, origin), init)
	const rawBody = await response.text()
	if (!response.ok) {
		throw new Error(
			`Request to ${pathname} failed with ${response.status}: ${rawBody}`,
		)
	}
	return JSON.parse(rawBody) as T
}

async function connectMcpClient(
	origin: string,
	headers: Record<string, string>,
) {
	const client = new Client(
		{
			name: 'kody-mcp-e2e-client',
			version: '1.0.0',
		},
		{ capabilities: {} },
	)
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
		requestInit: {
			headers,
		},
	})
	await client.connect(transport)
	return { client, transport }
}

async function closeMcpConnection(input: {
	client: Client
	transport: StreamableHTTPClientTransport
}) {
	await input.client.close().catch(() => undefined)
	await input.transport.terminateSession().catch(() => undefined)
	await input.transport.close().catch(() => undefined)
}

async function applyMigrations(persistDir: string) {
	const proc = spawnProcess({
		cmd: [
			nodeBin,
			'--env-file=packages/worker/.env',
			'./wrangler-env.ts',
			'd1',
			'migrations',
			'apply',
			'APP_DB',
			'--local',
			'--persist-to',
			persistDir,
		],
		cwd: projectRoot,
		env: {
			...process.env,
			CLOUDFLARE_ENV: 'test',
		},
	})
	const getStdout = captureOutput(proc.stdout)
	const getStderr = captureOutput(proc.stderr)
	const exitCode = await proc.exited
	if (exitCode === 0) return

	throw new Error(
		[
			`Failed to apply local D1 migrations (exit ${String(exitCode)}).`,
			getStdout(),
			getStderr(),
		]
			.filter(Boolean)
			.join('\n\n'),
	)
}

async function waitForServerReady(
	origin: string,
	exited: Promise<number | null>,
	getStdout: () => string,
	getStderr: () => string,
) {
	const deadline = Date.now() + defaultWaitTimeoutMs
	while (Date.now() < deadline) {
		const exitCode = await Promise.race([exited, delay(200).then(() => null)])
		if (typeof exitCode === 'number') {
			throw new Error(
				[
					`Test worker exited before becoming ready (exit ${exitCode}).`,
					getStdout(),
					getStderr(),
				]
					.filter(Boolean)
					.join('\n\n'),
			)
		}

		try {
			const response = await fetch(new URL('/mcp', origin))
			if (response.status === 401 || response.ok) {
				await response.body?.cancel()
				return
			}
			await response.body?.cancel()
		} catch {
			// Retry until the worker starts accepting connections.
		}
	}

	throw new Error(
		[
			`Timed out waiting for test worker at ${origin}.`,
			getStdout(),
			getStderr(),
		]
			.filter(Boolean)
			.join('\n\n'),
	)
}

async function waitForUrlReady(
	url: URL,
	exited: Promise<number | null>,
	getStdout: () => string,
	getStderr: () => string,
) {
	const deadline = Date.now() + defaultWaitTimeoutMs
	while (Date.now() < deadline) {
		const exitCode = await Promise.race([exited, delay(200).then(() => null)])
		if (typeof exitCode === 'number') {
			throw new Error(
				[
					`Test worker exited before becoming ready (exit ${exitCode}).`,
					getStdout(),
					getStderr(),
				]
					.filter(Boolean)
					.join('\n\n'),
			)
		}

		try {
			const response = await fetch(url)
			if (response.ok) {
				await response.body?.cancel()
				return
			}
			await response.body?.cancel()
		} catch {
			// Retry until the worker starts accepting connections.
		}
	}

	throw new Error(
		[
			`Timed out waiting for test worker at ${url.toString()}.`,
			getStdout(),
			getStderr(),
		]
			.filter(Boolean)
			.join('\n\n'),
	)
}

async function authenticateAppUser(
	origin: string,
	user: TestUser,
	mode: 'login' | 'signup',
) {
	return fetch(new URL('/auth', origin), {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			email: user.email,
			password: user.password,
			mode,
		}),
	})
}

function readCookieHeader(response: Response) {
	const cookie = response.headers.get('Set-Cookie')
	if (!cookie) {
		throw new Error('Authentication response did not include a session cookie.')
	}
	return cookie.split(';')[0] ?? cookie
}

async function registerOAuthClient(
	origin: string,
): Promise<OAuthClientRegistration> {
	const redirectUri = 'http://127.0.0.1/oauth/callback'
	const payload = await fetchJson<Record<string, unknown>>(
		origin,
		'/oauth/register',
		{
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				client_name: 'Kody MCP E2E Test Client',
				redirect_uris: [redirectUri],
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'client_secret_post',
			}),
		},
	)
	const clientId = readStringField(payload, 'client_id')
	const clientSecret = readStringField(payload, 'client_secret')
	return {
		clientId,
		clientSecret,
		redirectUri,
	}
}

async function authorizeOAuthClient(
	origin: string,
	client: OAuthClientRegistration,
	cookieHeader: string,
) {
	const authorizeUrl = new URL('/oauth/authorize', origin)
	const resource = new URL('/mcp', origin).toString()
	authorizeUrl.searchParams.set('response_type', 'code')
	authorizeUrl.searchParams.set('client_id', client.clientId)
	authorizeUrl.searchParams.set('redirect_uri', client.redirectUri)
	authorizeUrl.searchParams.set('scope', 'profile email')
	authorizeUrl.searchParams.set('state', 'kody-mcp-e2e-state')
	authorizeUrl.searchParams.set('resource', resource)

	const response = await fetch(authorizeUrl, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			Cookie: cookieHeader,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			decision: 'approve',
		}),
	})
	const rawBody = await response.text()
	if (!response.ok) {
		throw new Error(
			`OAuth authorize request failed with ${response.status}: ${rawBody}`,
		)
	}
	const payload = JSON.parse(rawBody) as Record<string, unknown>
	const redirectTo = readStringField(payload, 'redirectTo')
	const code = new URL(redirectTo).searchParams.get('code')
	if (!code) {
		throw new Error(
			`OAuth authorize response did not include a code: ${rawBody}`,
		)
	}
	return code
}

async function exchangeAuthorizationCode(
	origin: string,
	client: OAuthClientRegistration,
	code: string,
) {
	const resource = new URL('/mcp', origin).toString()
	const response = await fetch(new URL('/oauth/token', origin), {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: client.clientId,
			client_secret: client.clientSecret,
			redirect_uri: client.redirectUri,
			resource,
		}),
	})
	const rawBody = await response.text()
	if (!response.ok) {
		throw new Error(
			`OAuth token exchange failed with ${response.status}: ${rawBody}`,
		)
	}
	const payload = JSON.parse(rawBody) as Record<string, unknown>
	return readStringField(payload, 'access_token')
}

function readStringField(record: Record<string, unknown>, key: string) {
	const value = record[key]
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Expected "${key}" to be a non-empty string.`)
	}
	return value
}
