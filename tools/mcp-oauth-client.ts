import {
	Client as ModernClient,
	StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export type AppAuthUser = {
	email: string
	username: string
	password: string
}

export type OAuthClientRegistration = {
	clientId: string
	clientSecret: string
	redirectUri: string
}

export type McpConnection = {
	client: Client
	transport: StreamableHTTPClientTransport
}

export type FetchLike = typeof fetch

const defaultRedirectUri = 'http://127.0.0.1/oauth/callback'
const defaultOAuthClientName = 'Kody MCP E2E Test Client'
const defaultMcpClientName = 'kody-mcp-e2e-client'
const defaultControlKodyClientName = 'kody-control-kody'

export function usernameFromEmail(email: string) {
	const local = email.split('@')[0]?.trim()
	return local && local.length > 0 ? local : 'preview-user'
}

export function mcpAccountRejectedMessage(detail: string) {
	return [
		'MCP rejected this account.',
		'The preview seed (me@kentcdodds.com) is already email-verified; this CLI does not mark email verified via D1.',
		`Detail: ${detail}`,
	].join(' ')
}

export async function loginToApp(
	origin: string,
	user: AppAuthUser,
	fetchImpl: FetchLike = fetch,
) {
	const signupResponse = await authenticateAppUser(
		origin,
		user,
		'signup',
		fetchImpl,
	)
	// An already-registered email gets the same accepted body as a fresh
	// signup but no session cookie (anti-enumeration), so only a response
	// that actually set the session counts as a signup.
	if (
		signupResponse.ok &&
		signupResponse.headers.get('Set-Cookie')?.includes('kody_session=')
	) {
		return readCookieHeader(signupResponse)
	}

	const loginResponse = await authenticateAppUser(
		origin,
		user,
		'login',
		fetchImpl,
	)
	if (!loginResponse.ok) {
		const signupBody = await signupResponse.text()
		const loginBody = await loginResponse.text()
		throw new Error(
			`Failed to authenticate test user.\nSignup: ${signupResponse.status} ${signupBody}\nLogin: ${loginResponse.status} ${loginBody}`,
		)
	}

	return readCookieHeader(loginResponse)
}

export async function registerOAuthClient(
	origin: string,
	options: {
		clientName?: string
		redirectUri?: string
		fetchImpl?: FetchLike
	} = {},
): Promise<OAuthClientRegistration> {
	const redirectUri = options.redirectUri ?? defaultRedirectUri
	const fetchImpl = options.fetchImpl ?? fetch
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
				client_name: options.clientName ?? defaultOAuthClientName,
				redirect_uris: [redirectUri],
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'client_secret_post',
			}),
		},
		fetchImpl,
	)
	const clientId = readStringField(payload, 'client_id')
	const clientSecret = readStringField(payload, 'client_secret')
	return {
		clientId,
		clientSecret,
		redirectUri,
	}
}

export async function authorizeOAuthClient(
	origin: string,
	client: OAuthClientRegistration,
	cookieHeader: string,
	fetchImpl: FetchLike = fetch,
) {
	const authorizeUrl = new URL('/oauth/authorize', origin)
	const resource = new URL('/mcp', origin).toString()
	authorizeUrl.searchParams.set('response_type', 'code')
	authorizeUrl.searchParams.set('client_id', client.clientId)
	authorizeUrl.searchParams.set('redirect_uri', client.redirectUri)
	authorizeUrl.searchParams.set('scope', 'profile email')
	authorizeUrl.searchParams.set('state', 'kody-mcp-e2e-state')
	authorizeUrl.searchParams.set('resource', resource)

	const response = await fetchImpl(authorizeUrl, {
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

export async function exchangeAuthorizationCode(
	origin: string,
	client: OAuthClientRegistration,
	code: string,
	fetchImpl: FetchLike = fetch,
) {
	const resource = new URL('/mcp', origin).toString()
	const response = await fetchImpl(new URL('/oauth/token', origin), {
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

export async function connectMcpClient(
	origin: string,
	headers: Record<string, string>,
	options: { name?: string; version?: string } = {},
): Promise<McpConnection> {
	const client = new Client(
		{
			name: options.name ?? defaultMcpClientName,
			version: options.version ?? '1.0.0',
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

export async function closeMcpConnection(input: McpConnection) {
	await input.client.close().catch(() => undefined)
	await input.transport.terminateSession().catch(() => undefined)
	await input.transport.close().catch(() => undefined)
}

export async function connectAppMcpClient(
	origin: string,
	user: AppAuthUser,
	options: {
		extraHeaders?: Record<string, string>
		clientName?: string
		fetchImpl?: FetchLike
	} = {},
) {
	const fetchImpl = options.fetchImpl ?? fetch
	const cookieHeader = await loginToApp(origin, user, fetchImpl)
	const clientRegistration = await registerOAuthClient(origin, {
		clientName: options.clientName,
		fetchImpl,
	})
	const code = await authorizeOAuthClient(
		origin,
		clientRegistration,
		cookieHeader,
		fetchImpl,
	)
	const accessToken = await exchangeAuthorizationCode(
		origin,
		clientRegistration,
		code,
		fetchImpl,
	)
	// Preview and production Workers are multi-isolate: the legacy
	// sessionful SDK v1 client initializes, then hangs on the next request.
	// Pin the stateless 2026-07-28 lane so each tool call is self-contained.
	let client: ModernClient
	let transport: ModernStreamableHTTPClientTransport
	try {
		const connected = await connectStatelessMcpClient(
			origin,
			{
				Authorization: `Bearer ${accessToken}`,
				...options.extraHeaders,
			},
			{ name: options.clientName ?? defaultControlKodyClientName },
		)
		client = connected.client
		transport = connected.transport
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new Error(mcpAccountRejectedMessage(detail))
	}
	return {
		cookieHeader,
		client,
		async [Symbol.asyncDispose]() {
			await client.close().catch(() => undefined)
			await transport.close().catch(() => undefined)
		},
	}
}

export async function connectStatelessMcpClient(
	origin: string,
	headers: Record<string, string>,
	options: { name?: string; version?: string } = {},
) {
	const client = new ModernClient(
		{
			name: options.name ?? defaultControlKodyClientName,
			version: options.version ?? '1.0.0',
		},
		{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
	)
	const transport = new ModernStreamableHTTPClientTransport(
		new URL('/mcp', origin),
		{
			requestInit: {
				headers,
			},
		},
	)
	await client.connect(transport)
	return { client, transport }
}

async function authenticateAppUser(
	origin: string,
	user: AppAuthUser,
	mode: 'login' | 'signup',
	fetchImpl: FetchLike,
) {
	return fetchImpl(new URL('/auth', origin), {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			email: user.email,
			...(mode === 'signup' ? { username: user.username } : {}),
			password: user.password,
			mode,
		}),
	})
}

export function readCookieHeader(response: Response) {
	const cookie = response.headers.get('Set-Cookie')
	if (!cookie) {
		throw new Error('Authentication response did not include a session cookie.')
	}
	return cookie.split(';')[0] ?? cookie
}

async function fetchJson<T = Record<string, unknown>>(
	origin: string,
	pathname: string,
	init: RequestInit | undefined,
	fetchImpl: FetchLike,
): Promise<T> {
	const response = await fetchImpl(new URL(pathname, origin), init)
	const rawBody = await response.text()
	if (!response.ok) {
		throw new Error(
			`Request to ${pathname} failed with ${response.status}: ${rawBody}`,
		)
	}
	return JSON.parse(rawBody) as T
}

export function readStringField(record: Record<string, unknown>, key: string) {
	const value = record[key]
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Expected "${key}" to be a non-empty string.`)
	}
	return value
}
