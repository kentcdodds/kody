import {
	type MockAiStateMessage,
	type StoredMockRequest,
} from './mock-requests-do.ts'
import { buildMockAiScenario } from '@kody-internal/shared/mock-ai.ts'

type MockAiEnv = {
	MOCK_API_TOKEN?: string
	MOCK_AI_STATE: DurableObjectNamespace
}

type DashboardEndpoint = {
	method: string
	path: string
	description: string
	requiresAuth: boolean
}

const dashboardEndpoints: Array<DashboardEndpoint> = [
	{
		method: 'POST',
		path: '/chat',
		description: 'Return deterministic mock AI scenarios for chat requests.',
		requiresAuth: true,
	},
	{
		method: 'GET',
		path: '/__mocks',
		description: 'Mock dashboard (HTML)',
		requiresAuth: false,
	},
	{
		method: 'GET',
		path: '/__mocks/meta',
		description: 'Mock metadata (JSON)',
		requiresAuth: false,
	},
	{
		method: 'GET',
		path: '/__mocks/requests',
		description: 'List stored requests (JSON)',
		requiresAuth: true,
	},
	{
		method: 'POST',
		path: '/__mocks/clear',
		description: 'Delete stored requests for this token (JSON)',
		requiresAuth: true,
	},
]

function json(data: unknown, init: ResponseInit = {}) {
	const headers = new Headers(init.headers)
	if (!headers.has('content-type')) {
		headers.set('content-type', 'application/json; charset=utf-8')
	}
	return new Response(JSON.stringify(data, null, 2), { ...init, headers })
}

function htmlEscape(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

function parseBearerToken(headerValue: string | null) {
	if (!headerValue) return null
	const match = headerValue.match(/^Bearer\s+(.+)\s*$/i)
	return match?.[1]?.trim() || null
}

function getCookieValue(cookieHeader: string | null, name: string) {
	if (!cookieHeader) return null
	for (const part of cookieHeader.split(';')) {
		const [rawKey, ...rest] = part.trim().split('=')
		if (!rawKey || rawKey !== name) continue
		return rest.join('=')
	}
	return null
}

function readAuthToken(request: Request, url: URL) {
	const bearer = parseBearerToken(request.headers.get('authorization'))
	if (bearer) return bearer

	const headerToken = request.headers.get('x-mock-token')?.trim()
	if (headerToken) return headerToken

	const urlToken = url.searchParams.get('token')?.trim()
	if (urlToken) return urlToken

	const cookieToken = getCookieValue(
		request.headers.get('cookie'),
		'mock_token',
	)
	if (cookieToken) return cookieToken

	return null
}

function isAuthorized(request: Request, env: MockAiEnv, url: URL) {
	const expected = env.MOCK_API_TOKEN?.trim() ?? ''
	if (!expected) return true
	const provided = readAuthToken(request, url)
	return Boolean(provided && provided === expected)
}

async function sha256Hex(value: string) {
	const data = new TextEncoder().encode(value)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

function getTokenPartition(env: MockAiEnv) {
	const expected = env.MOCK_API_TOKEN?.trim() ?? ''
	return expected ? sha256Hex(expected) : Promise.resolve('public')
}

function withTokenQueryParam(baseUrl: URL, href: string, token: string | null) {
	if (!token) return href
	const next = new URL(href, baseUrl)
	next.searchParams.set('token', token)
	return `${next.pathname}${next.search}${next.hash}`
}

async function callState<TResponse>(
	stub: DurableObjectStub,
	payload: MockAiStateMessage,
) {
	const response = await stub.fetch('https://mock-ai-state/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	})
	if (!response.ok) {
		const detail = await response.text()
		throw new Error(`Mock AI state failed (${response.status}): ${detail}`)
	}
	return (await response.json()) as TResponse
}

function getLastUserMessageText(
	messages: Array<{
		role?: string
		parts?: Array<{ type?: string; text?: string }>
	}>,
) {
	const userMessages = messages.filter((message) => message.role === 'user')
	const lastUserMessage = userMessages.at(-1)
	if (!lastUserMessage) return ''
	return (
		lastUserMessage.parts
			?.filter((part) => part.type === 'text' && typeof part.text === 'string')
			.map((part) => part.text ?? '')
			.join('\n')
			.trim() ?? ''
	)
}

async function handleChat(request: Request, env: MockAiEnv, url: URL) {
	if (!isAuthorized(request, env, url)) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	let body: unknown
	try {
		body = await request.json()
	} catch {
		return json({ error: 'Invalid JSON payload.' }, { status: 400 })
	}

	const messages = Array.isArray((body as { messages?: unknown }).messages)
		? ((body as { messages: Array<unknown> }).messages as Array<{
				role?: string
				parts?: Array<{ type?: string; text?: string }>
			}>)
		: []
	const toolNames = Array.isArray((body as { toolNames?: unknown }).toolNames)
		? ((body as { toolNames: Array<unknown> }).toolNames.filter(
				(value): value is string => typeof value === 'string',
			) as Array<string>)
		: []
	const lastUserMessage = getLastUserMessageText(messages)
	const { scenario, response } = buildMockAiScenario({
		lastUserMessage,
		toolNames,
	})

	const tokenHash = await getTokenPartition(env)
	const state = getMockAiState(env, tokenHash)
	await callState(state, {
		action: 'append',
		request: {
			id: `mock_ai_${crypto.randomUUID()}`,
			token_hash: tokenHash,
			received_at: Date.now(),
			scenario,
			last_user_message: lastUserMessage,
			tool_names_json: JSON.stringify(toolNames),
			request_json: JSON.stringify(body ?? null),
			response_text: JSON.stringify(response),
		},
	})

	return json(response)
}

async function handleMeta(request: Request, env: MockAiEnv, url: URL) {
	const authorized = isAuthorized(request, env, url)
	const tokenHash = authorized ? await getTokenPartition(env) : null
	const requestCount = tokenHash
		? (
				await callState<{ count: number }>(getMockAiState(env, tokenHash), {
					action: 'count',
				})
			).count
		: undefined

	return json({
		service: 'ai',
		authorized,
		endpoints: dashboardEndpoints,
		...(requestCount !== undefined ? { requestCount } : {}),
	})
}

async function handleGetRequests(request: Request, env: MockAiEnv, url: URL) {
	if (!isAuthorized(request, env, url)) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	const tokenHash = await getTokenPartition(env)
	const requests = (
		await callState<{ requests: Array<StoredMockRequest> }>(
			getMockAiState(env, tokenHash),
			{
				action: 'list',
				limit: 100,
			},
		)
	).requests
	return json({ count: requests.length, requests })
}

async function handleClear(request: Request, env: MockAiEnv, url: URL) {
	if (!isAuthorized(request, env, url)) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	const tokenHash = await getTokenPartition(env)
	await callState(getMockAiState(env, tokenHash), { action: 'clear' })
	return json({ ok: true })
}

function getMockAiState(env: MockAiEnv, tokenHash: string) {
	const stateId = env.MOCK_AI_STATE.idFromName(tokenHash)
	return env.MOCK_AI_STATE.get(stateId)
}

async function handleDashboard(request: Request, env: MockAiEnv, url: URL) {
	const meta = (await handleMeta(request, env, url).then((response) =>
		response.json(),
	)) as {
		authorized: boolean
		requestCount?: number
	}

	const tokenParam = url.searchParams.get('token')
	const dashboardToken = tokenParam?.trim() ? tokenParam.trim() : null
	const tokenHint = env.MOCK_API_TOKEN?.trim()
		? 'This mock requires a token (Authorization: Bearer ... or ?token=...).'
		: 'No token is configured; mock endpoints are open.'

	const endpointRows = dashboardEndpoints
		.map((endpoint) => {
			const accessLabel = endpoint.requiresAuth ? 'auth' : 'public'
			const endpointHref = withTokenQueryParam(
				url,
				endpoint.path,
				dashboardToken,
			)
			return `<tr>
				<td><code>${htmlEscape(endpoint.method)}</code></td>
				<td><code>${htmlEscape(endpoint.path)}</code></td>
				<td>${htmlEscape(accessLabel)}</td>
				<td>${
					endpoint.method === 'GET'
						? `<a href="${htmlEscape(endpointHref)}">${htmlEscape(endpoint.description)}</a>`
						: htmlEscape(endpoint.description)
				}</td>
			</tr>`
		})
		.join('')

	return new Response(
		`<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<title>Mock: AI</title>
		<style>
			body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px; color: #0f172a; background: #f8fafc; }
			.container { max-width: 960px; margin: 0 auto; display: grid; gap: 16px; }
			.card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; }
			table { width: 100%; border-collapse: collapse; }
			th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
			code { background: #f1f5f9; padding: 2px 6px; border-radius: 6px; }
			p { margin: 0; }
			a { color: #2563eb; text-decoration: none; }
			a:hover { text-decoration: underline; }
		</style>
	</head>
	<body>
		<div class="container">
			<div class="card">
				<h1>Mock: AI</h1>
				<p>${htmlEscape(tokenHint)}</p>
			</div>
			<div class="card">
				<p><strong>Authorized:</strong> ${meta.authorized ? 'yes' : 'no'}</p>
				<p><strong>Stored requests:</strong> ${meta.requestCount ?? 'hidden'}</p>
			</div>
			<div class="card">
				<h2>Endpoints</h2>
				<table>
					<thead>
						<tr><th>Method</th><th>Path</th><th>Access</th><th>Description</th></tr>
					</thead>
					<tbody>${endpointRows}</tbody>
				</table>
			</div>
		</div>
	</body>
</html>`,
		{
			headers: { 'content-type': 'text/html; charset=utf-8' },
		},
	)
}

export default {
	async fetch(request: Request, env: MockAiEnv) {
		const url = new URL(request.url)

		if (request.method === 'GET' && url.pathname === '/') {
			const destination = new URL('/__mocks', url)
			destination.search = url.search
			return Response.redirect(destination.toString(), 302)
		}

		if (request.method === 'POST' && url.pathname === '/chat') {
			return handleChat(request, env, url)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks') {
			return handleDashboard(request, env, url)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks/meta') {
			return handleMeta(request, env, url)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks/requests') {
			return handleGetRequests(request, env, url)
		}

		if (request.method === 'POST' && url.pathname === '/__mocks/clear') {
			return handleClear(request, env, url)
		}

		return new Response('Not Found', { status: 404 })
	},
} satisfies ExportedHandler<MockAiEnv>

export { MockAiState } from './mock-requests-do.ts'
