/**
 * Minimal Cloudflare API v4 mock for local dev and tests.
 * Mirrors Cloudflare API v4 routes used by tests and internal clients.
 */
import { parseSafe } from 'remix/data-schema'
import {
	outboundEmailSchema,
	type OutboundEmail,
} from '@kody-internal/shared/outbound-email.ts'
import { createMockCloudflareEmailState } from './mock-email-messages-do.ts'

type MockCloudflareEnv = {
	MOCK_API_TOKEN?: string
	MOCK_CLOUDFLARE_EMAIL_STATE: DurableObjectNamespace
}

type ZoneRecord = {
	id: string
	name: string
	status: string
	account: { id: string; name: string }
}

type DnsRecord = {
	id: string
	type: string
	name: string
	content: string
	proxied: boolean
	ttl: number
}

type DashboardEndpoint = {
	method: string
	path: string
	description: string
	requiresAuth: boolean
}

const fixtureAccount = {
	id: 'cf_account_mock_123',
	name: 'Mock Account',
}

const fixtureZone: ZoneRecord = {
	id: 'zone-123',
	name: 'example.com',
	status: 'active',
	account: fixtureAccount,
}

const zoneDnsRecords = new Map<string, Array<DnsRecord>>([
	[
		fixtureZone.id,
		[
			{
				id: 'dns_mock_1',
				type: 'A',
				name: 'example.com',
				content: '192.0.2.10',
				proxied: true,
				ttl: 1,
			},
		],
	],
])

const dashboardEndpoints: Array<DashboardEndpoint> = [
	{
		method: 'GET',
		path: '/client/v4/accounts',
		description: 'List accounts',
		requiresAuth: true,
	},
	{
		method: 'GET',
		path: '/client/v4/zones',
		description: 'List zones',
		requiresAuth: true,
	},
	{
		method: 'GET',
		path: `/client/v4/zones/${fixtureZone.id}/dns_records`,
		description: 'List DNS records',
		requiresAuth: true,
	},
	{
		method: 'POST',
		path: `/client/v4/zones/${fixtureZone.id}/dns_records`,
		description: 'Create DNS record',
		requiresAuth: true,
	},
	{
		method: 'POST',
		path: `/client/v4/accounts/${fixtureAccount.id}/email/sending/send`,
		description: 'Send an outbound email',
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
		path: '/__mocks/messages',
		description: 'List stored email messages (JSON)',
		requiresAuth: true,
	},
	{
		method: 'POST',
		path: '/__mocks/clear',
		description: 'Delete stored email messages for this token (JSON)',
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

function envelope(
	result: unknown,
	init: ResponseInit = {},
	resultInfo?: Record<string, unknown>,
) {
	return json(
		{
			success: init.status ? init.status < 400 : true,
			errors: [],
			messages: [],
			result,
			...(resultInfo ? { result_info: resultInfo } : {}),
		},
		init,
	)
}

function errorEnvelope(
	status: number,
	code: number | string,
	message: string,
	result: unknown = null,
) {
	return json(
		{
			success: false,
			errors: [{ code, message }],
			messages: [],
			result,
		},
		{ status },
	)
}

function htmlEscape(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

function withTokenQueryParam(baseUrl: URL, href: string, token: string | null) {
	if (!token) return href
	const next = new URL(href, baseUrl)
	next.searchParams.set('token', token)
	return `${next.pathname}${next.search}${next.hash}`
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
		if (!rawKey) continue
		if (rawKey !== name) continue
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

function isAuthorized(request: Request, env: MockCloudflareEnv, url: URL) {
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

function getTokenPartition(env: MockCloudflareEnv) {
	const expected = env.MOCK_API_TOKEN?.trim() ?? ''
	return expected ? sha256Hex(expected) : Promise.resolve('public')
}

function getMockEmailState(env: MockCloudflareEnv, tokenHash: string) {
	const id = env.MOCK_CLOUDFLARE_EMAIL_STATE.idFromName(tokenHash)
	return createMockCloudflareEmailState(env.MOCK_CLOUDFLARE_EMAIL_STATE.get(id))
}

async function readJsonBody(request: Request) {
	try {
		const text = await request.text()
		if (!text.trim()) return {}
		return JSON.parse(text) as Record<string, unknown>
	} catch {
		return null
	}
}

async function handleMeta(request: Request, env: MockCloudflareEnv, url: URL) {
	const authorized = isAuthorized(request, env, url)
	const tokenHash = authorized ? await getTokenPartition(env) : null
	return json({
		service: 'cloudflare',
		authorized,
		basePath: '/client/v4',
		accountId: fixtureAccount.id,
		endpoints: dashboardEndpoints,
		...(tokenHash
			? {
					messageCount: await getMockEmailState(env, tokenHash).countMessages(),
				}
			: {}),
	})
}

async function handleGetMessages(
	request: Request,
	env: MockCloudflareEnv,
	url: URL,
) {
	if (!isAuthorized(request, env, url)) {
		return errorEnvelope(401, 10000, 'Authentication error')
	}
	const tokenHash = await getTokenPartition(env)
	const state = getMockEmailState(env, tokenHash)
	const messageId = url.pathname.startsWith('/__mocks/messages/')
		? url.pathname.slice('/__mocks/messages/'.length).trim()
		: ''
	if (messageId) {
		const message = await state.getMessage(messageId)
		if (!message) {
			return errorEnvelope(404, 1002, 'message not found')
		}
		return json({ message })
	}

	const limitParam = url.searchParams.get('limit')?.trim() ?? ''
	const limit = Math.min(
		100,
		Math.max(1, Number.parseInt(limitParam || '50', 10)),
	)
	const messages = await state.listMessages(limit)
	return json({ count: messages.length, messages })
}

async function handleClear(request: Request, env: MockCloudflareEnv, url: URL) {
	if (!isAuthorized(request, env, url)) {
		return errorEnvelope(401, 10000, 'Authentication error')
	}
	const tokenHash = await getTokenPartition(env)
	await getMockEmailState(env, tokenHash).clearMessages()
	return json({ ok: true })
}

async function handleDashboard(
	request: Request,
	env: MockCloudflareEnv,
	url: URL,
) {
	const meta = (await handleMeta(request, env, url).then((response) =>
		response.json(),
	)) as {
		authorized: boolean
		messageCount?: number
	}

	const dashboardToken = url.searchParams.get('token')?.trim() || null
	const tokenHint = env.MOCK_API_TOKEN?.trim()
		? 'This mock requires a token (Authorization: Bearer ... or ?token=...).'
		: 'No token is configured; protected routes are open.'

	const endpointRows = dashboardEndpoints
		.map((endpoint) => {
			const authBadge = endpoint.requiresAuth
				? '<span class="badge badge-warn">auth</span>'
				: '<span class="badge">public</span>'
			const endpointHref = withTokenQueryParam(
				url,
				endpoint.path,
				dashboardToken,
			)
			const pathCell =
				endpoint.method === 'GET'
					? `<a href="${htmlEscape(endpointHref)}"><code>${htmlEscape(endpoint.path)}</code></a>`
					: `<code>${htmlEscape(endpoint.path)}</code>`
			return `<tr>
				<td><code>${htmlEscape(endpoint.method)}</code></td>
				<td>${pathCell}</td>
				<td>${authBadge}</td>
				<td>${htmlEscape(endpoint.description)}</td>
			</tr>`
		})
		.join('')

	const messageCountLine = meta.authorized
		? `<span class="stat-value">${meta.messageCount ?? 0}</span>`
		: '<span class="stat-value muted">hidden</span>'

	const body = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<title>Mock: Cloudflare API</title>
		<style>
			:root {
				color-scheme: light dark;
				--bg: #f8fafc;
				--text: #0f172a;
				--muted: #475569;
				--border: #e2e8f0;
				--card-bg: #ffffff;
				--table-border: #e2e8f0;
				--code-bg: #f1f5f9;
				--code-text: #0f172a;
				--badge-bg: #e2e8f0;
				--badge-text: #334155;
				--badge-warn-bg: #fee2e2;
				--badge-warn-text: #991b1b;
				--link: #2563eb;
			}

			@media (prefers-color-scheme: dark) {
				:root {
					--bg: #0b1220;
					--text: #e2e8f0;
					--muted: #94a3b8;
					--border: #1e293b;
					--card-bg: #0f172a;
					--table-border: #1e293b;
					--code-bg: #111827;
					--code-text: #e2e8f0;
					--badge-bg: #1f2937;
					--badge-text: #e2e8f0;
					--badge-warn-bg: #7f1d1d;
					--badge-warn-text: #fecaca;
					--link: #60a5fa;
				}
			}

			body {
				margin: 0;
				background: var(--bg);
				font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto,
					sans-serif;
				padding: 24px;
				color: var(--text);
			}
			.container { max-width: 960px; margin: 0 auto; }
			h1 { margin: 0 0 8px; font-size: 22px; }
			.subtitle { margin: 0 0 24px; color: var(--muted); }
			.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 16px 0 24px; }
			.card { border: 1px solid var(--border); border-radius: 12px; padding: 16px; background: var(--card-bg); }
			.stat-label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
			.stat-value { font-size: 18px; font-weight: 600; }
			.muted { color: var(--muted); font-weight: 500; }
			table { width: 100%; border-collapse: collapse; }
			th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--table-border); vertical-align: top; }
			th { font-size: 12px; color: var(--muted); font-weight: 600; }
			code { background: var(--code-bg); color: var(--code-text); padding: 2px 6px; border-radius: 6px; }
			.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: var(--badge-bg); color: var(--badge-text); }
			.badge-warn { background: var(--badge-warn-bg); color: var(--badge-warn-text); }
			.footer { margin-top: 24px; color: var(--muted); font-size: 12px; }
			a { color: var(--link); text-decoration: none; }
			a:hover { text-decoration: underline; }

			@media (max-width: 640px) {
				body { padding: 16px; }
				h1 { font-size: 20px; }
				.subtitle { margin-bottom: 16px; font-size: 14px; }
				.grid { grid-template-columns: 1fr; margin: 12px 0 16px; }
				.card { border-radius: 10px; padding: 12px; }
				table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
				th, td { padding: 8px 6px; }
			}
		</style>
	</head>
	<body>
		<div class="container">
			<h1>Mock: Cloudflare API</h1>
			<p class="subtitle">${htmlEscape(tokenHint)}</p>
			<div class="grid">
				<div class="card">
					<div class="stat-label">Auth</div>
					<div class="stat-value">${meta.authorized ? 'authorized' : 'unauthorized'}</div>
				</div>
				<div class="card">
					<div class="stat-label">Stored emails</div>
					<div class="stat-value">${messageCountLine}</div>
				</div>
			</div>
			<div class="card">
				<h2 style="margin: 0 0 12px; font-size: 16px;">Endpoints</h2>
				<table>
					<thead>
						<tr>
							<th style="width: 110px;">Method</th>
							<th style="width: 320px;">Path</th>
							<th style="width: 90px;">Access</th>
							<th>Description</th>
						</tr>
					</thead>
					<tbody>
						${endpointRows}
					</tbody>
				</table>
				<p class="footer">
					Meta: <a href="${htmlEscape(withTokenQueryParam(url, '/__mocks/meta', dashboardToken))}">/__mocks/meta</a>
					· Messages: <a href="${htmlEscape(withTokenQueryParam(url, '/__mocks/messages', dashboardToken))}">/__mocks/messages</a>
				</p>
			</div>
		</div>
	</body>
</html>`

	return new Response(body, {
		headers: { 'content-type': 'text/html; charset=utf-8' },
	})
}

async function handleEmailSend(
	request: Request,
	env: MockCloudflareEnv,
	accountId: string,
) {
	if (accountId !== fixtureAccount.id) {
		return errorEnvelope(404, 1002, 'account not found')
	}
	const body = await readJsonBody(request)
	if (body === null) {
		return errorEnvelope(400, 1001, 'invalid JSON body')
	}
	const parsed = parseSafe(outboundEmailSchema, body)
	if (!parsed.success) {
		return errorEnvelope(400, 'E_VALIDATION_ERROR', 'Invalid email payload.')
	}

	const tokenHash = await getTokenPartition(env)
	const state = getMockEmailState(env, tokenHash)
	const now = Date.now()
	const messageId = `email_${crypto.randomUUID()}`
	const payload = parsed.value as OutboundEmail

	await state.addMessage(tokenHash, {
		id: messageId,
		received_at: now,
		from_email: payload.from,
		to_json: JSON.stringify(payload.to),
		subject: payload.subject,
		html: payload.html,
		text: payload.text ?? null,
		payload_json: JSON.stringify(payload),
	})

	return envelope(
		{
			delivered: Array.isArray(payload.to) ? payload.to : [payload.to],
			permanent_bounces: [],
			queued: [],
		},
		{ status: 200 },
	)
}

async function routeApi(request: Request, env: MockCloudflareEnv, url: URL) {
	if (!isAuthorized(request, env, url)) {
		return errorEnvelope(401, 10000, 'Authentication error')
	}

	if (request.method === 'GET' && url.pathname === '/client/v4/accounts') {
		return envelope(
			[fixtureAccount],
			{ status: 200 },
			{
				page: 1,
				per_page: 20,
				total_pages: 1,
				count: 1,
				total_count: 1,
			},
		)
	}

	if (request.method === 'GET' && url.pathname === '/client/v4/zones') {
		return envelope(
			[fixtureZone],
			{ status: 200 },
			{
				page: 1,
				per_page: 20,
				total_pages: 1,
				count: 1,
				total_count: 1,
			},
		)
	}

	if (
		request.method === 'GET' &&
		url.pathname === '/client/v4/user/tokens/verify'
	) {
		return envelope(
			{
				id: 'token_mock_123',
				status: 'active',
				expires_on: null,
			},
			{ status: 200 },
		)
	}

	const emailMatch = url.pathname.match(
		/^\/client\/v4\/accounts\/([^/]+)\/email\/sending\/send\/?$/,
	)
	if (emailMatch && request.method === 'POST') {
		return handleEmailSend(request, env, emailMatch[1]!)
	}

	const dnsListMatch = url.pathname.match(
		/^\/client\/v4\/zones\/([^/]+)\/dns_records\/?$/,
	)
	if (dnsListMatch && request.method === 'GET') {
		const zoneId = dnsListMatch[1]!
		return envelope(
			zoneDnsRecords.get(zoneId) ?? [],
			{ status: 200 },
			{
				page: 1,
				per_page: 20,
				total_pages: 1,
				count: zoneDnsRecords.get(zoneId)?.length ?? 0,
				total_count: zoneDnsRecords.get(zoneId)?.length ?? 0,
			},
		)
	}

	if (dnsListMatch && request.method === 'POST') {
		const zoneId = dnsListMatch[1]!
		const payload = await readJsonBody(request)
		if (payload === null) {
			return errorEnvelope(400, 1001, 'invalid JSON body')
		}
		const nextRecord: DnsRecord = {
			id: `dns_mock_${Date.now()}`,
			type: typeof payload.type === 'string' ? payload.type : 'A',
			name: typeof payload.name === 'string' ? payload.name : fixtureZone.name,
			content:
				typeof payload.content === 'string' ? payload.content : '192.0.2.20',
			proxied: Boolean(payload.proxied),
			ttl:
				typeof payload.ttl === 'number' && Number.isFinite(payload.ttl)
					? payload.ttl
					: 1,
		}
		const records = zoneDnsRecords.get(zoneId) ?? []
		records.push(nextRecord)
		zoneDnsRecords.set(zoneId, records)
		return envelope(nextRecord, { status: 200 })
	}

	return null
}

export default {
	async fetch(request: Request, env: MockCloudflareEnv, ctx: ExecutionContext) {
		void ctx
		const url = new URL(request.url)

		if (request.method === 'GET' && url.pathname === '/') {
			const destination = new URL('/__mocks', url)
			destination.search = url.search
			return Response.redirect(destination.toString(), 302)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks') {
			return handleDashboard(request, env, url)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks/meta') {
			return handleMeta(request, env, url)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks/messages') {
			return handleGetMessages(request, env, url)
		}

		if (
			request.method === 'GET' &&
			url.pathname.startsWith('/__mocks/messages/')
		) {
			return handleGetMessages(request, env, url)
		}

		if (request.method === 'POST' && url.pathname === '/__mocks/clear') {
			return handleClear(request, env, url)
		}

		const apiResponse = await routeApi(request, env, url)
		if (apiResponse) return apiResponse

		return new Response('Not Found', { status: 404 })
	},
} satisfies ExportedHandler<MockCloudflareEnv>

export {
	MockCloudflareEmailMessagesDurableObject,
	createMockCloudflareEmailState,
} from './mock-email-messages-do.ts'
