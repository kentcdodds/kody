import { parseSafe } from 'remix/data-schema'
import { resendEmailSchema } from '#shared/resend-email.ts'
import { createDb, mockResendMessagesTable } from '#worker/db.ts'

type MockResendEnv = {
	APP_DB: D1Database
	MOCK_API_TOKEN?: string
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
		path: '/emails',
		description: 'Create an email message (Resend API compatible)',
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
		description: 'List stored messages (JSON)',
		requiresAuth: true,
	},
	{
		method: 'POST',
		path: '/__mocks/clear',
		description: 'Delete stored messages for this token (JSON)',
		requiresAuth: true,
	},
]

let schemaReady: Promise<void> | null = null

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

function json(data: unknown, init: ResponseInit = {}) {
	const headers = new Headers(init.headers)
	if (!headers.has('content-type')) {
		headers.set('content-type', 'application/json; charset=utf-8')
	}
	return new Response(JSON.stringify(data, null, 2), { ...init, headers })
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

function isAuthorized(request: Request, env: MockResendEnv, url: URL) {
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

function getTokenPartition(env: MockResendEnv) {
	const expected = env.MOCK_API_TOKEN?.trim() ?? ''
	return expected ? sha256Hex(expected) : Promise.resolve('public')
}

type MockResendDb = ReturnType<typeof createDb>

async function ensureSchema(db: MockResendDb) {
	if (!schemaReady) {
		schemaReady = (async () => {
			await db.exec(`CREATE TABLE IF NOT EXISTS mock_resend_messages (
				id TEXT PRIMARY KEY,
				token_hash TEXT NOT NULL,
				received_at INTEGER NOT NULL,
				from_email TEXT NOT NULL,
				to_json TEXT NOT NULL,
				subject TEXT NOT NULL,
				html TEXT NOT NULL,
				payload_json TEXT NOT NULL
			)`)
			await db.exec(`CREATE INDEX IF NOT EXISTS mock_resend_messages_token_received_at
				ON mock_resend_messages(token_hash, received_at DESC)`)
		})().catch((error) => {
			schemaReady = null
			throw error
		})
	}
	await schemaReady
}

async function readJsonBody(request: Request) {
	try {
		return await request.json()
	} catch {
		return null
	}
}

async function countMessages(db: MockResendDb, tokenHash: string) {
	await ensureSchema(db)
	return db.count(mockResendMessagesTable, {
		where: { token_hash: tokenHash },
	})
}

async function listMessages(
	db: MockResendDb,
	tokenHash: string,
	limit: number,
) {
	await ensureSchema(db)
	return db.findMany(mockResendMessagesTable, {
		where: { token_hash: tokenHash },
		orderBy: ['received_at', 'desc'],
		limit,
	})
}

async function getMessage(db: MockResendDb, tokenHash: string, id: string) {
	await ensureSchema(db)
	return db.findOne(mockResendMessagesTable, {
		where: { token_hash: tokenHash, id },
	})
}

async function clearMessages(db: MockResendDb, tokenHash: string) {
	await ensureSchema(db)
	await db.deleteMany(mockResendMessagesTable, {
		where: { token_hash: tokenHash },
	})
}

async function handlePostEmails(
	request: Request,
	env: MockResendEnv,
	url: URL,
) {
	if (!isAuthorized(request, env, url)) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	const db = createDb(env.APP_DB)
	const body = await readJsonBody(request)
	const parsed = parseSafe(resendEmailSchema, body)
	if (!parsed.success) {
		return json({ error: 'Invalid email payload.' }, { status: 400 })
	}

	await ensureSchema(db)
	const tokenHash = await getTokenPartition(env)
	const now = Date.now()
	const id = `email_${crypto.randomUUID()}`
	const payloadJson = JSON.stringify(parsed.value)

	await db.create(mockResendMessagesTable, {
		id,
		token_hash: tokenHash,
		received_at: now,
		from_email: parsed.value.from,
		to_json: JSON.stringify(parsed.value.to),
		subject: parsed.value.subject,
		html: parsed.value.html,
		payload_json: payloadJson,
	})

	// Mirror Resend's happy-path shape.
	return json({ id }, { status: 200 })
}

async function handleGetMeta(request: Request, env: MockResendEnv, url: URL) {
	const authorized = isAuthorized(request, env, url)
	const tokenHash = authorized ? await getTokenPartition(env) : null
	const db = createDb(env.APP_DB)

	return json({
		service: 'resend',
		authorized,
		endpoints: dashboardEndpoints,
		...(tokenHash
			? {
					messageCount: await countMessages(db, tokenHash),
				}
			: {}),
	})
}

async function handleGetMessages(
	request: Request,
	env: MockResendEnv,
	url: URL,
) {
	if (!isAuthorized(request, env, url)) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}
	const db = createDb(env.APP_DB)
	const tokenHash = await getTokenPartition(env)
	const messageId = url.pathname.startsWith('/__mocks/messages/')
		? url.pathname.slice('/__mocks/messages/'.length).trim()
		: ''
	if (messageId) {
		const message = await getMessage(db, tokenHash, messageId)
		if (!message) {
			return json({ error: 'Not Found' }, { status: 404 })
		}
		return json({ message })
	}
	const limitParam = url.searchParams.get('limit')?.trim() ?? ''
	const limit = Math.min(
		100,
		Math.max(1, Number.parseInt(limitParam || '50', 10)),
	)

	const messages = await listMessages(db, tokenHash, limit)
	return json({ count: messages.length, messages })
}

async function handleClear(request: Request, env: MockResendEnv, url: URL) {
	if (!isAuthorized(request, env, url)) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}
	const db = createDb(env.APP_DB)
	const tokenHash = await getTokenPartition(env)
	await clearMessages(db, tokenHash)
	return json({ ok: true })
}

async function handleDashboard(request: Request, env: MockResendEnv, url: URL) {
	const meta = (await handleGetMeta(request, env, url).then((res) =>
		res.json(),
	)) as {
		authorized: boolean
		messageCount?: number
	}

	const tokenParam = url.searchParams.get('token')
	const dashboardToken = tokenParam?.trim() ? tokenParam.trim() : null

	const tokenHint = env.MOCK_API_TOKEN?.trim()
		? 'This mock requires a token (Authorization: Bearer ... or ?token=...).'
		: 'No token is configured; mock endpoints are open.'

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
		: `<span class="stat-value muted">hidden</span>`

	const body = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<title>Mock: Resend</title>
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
			<h1>Mock: Resend</h1>
			<p class="subtitle">${htmlEscape(tokenHint)}</p>
			<div class="grid">
				<div class="card">
					<div class="stat-label">Auth</div>
					<div class="stat-value">${meta.authorized ? 'authorized' : 'unauthorized'}</div>
				</div>
				<div class="card">
					<div class="stat-label">Stored messages</div>
					<div class="stat-value">${messageCountLine}</div>
				</div>
			</div>
			<div class="card">
				<h2 style="margin: 0 0 12px; font-size: 16px;">Endpoints</h2>
				<table>
					<thead>
						<tr>
							<th style="width: 110px;">Method</th>
							<th style="width: 220px;">Path</th>
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
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8' },
	})
}

export default {
	async fetch(request: Request, env: MockResendEnv, ctx: ExecutionContext) {
		void ctx
		const url = new URL(request.url)

		if (request.method === 'GET' && url.pathname === '/') {
			const destination = new URL('/__mocks', url)
			destination.search = url.search
			return Response.redirect(destination.toString(), 302)
		}

		if (request.method === 'POST' && url.pathname === '/emails') {
			return handlePostEmails(request, env, url)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks') {
			return handleDashboard(request, env, url)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks/meta') {
			return handleGetMeta(request, env, url)
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

		return new Response('Not Found', { status: 404 })
	},
} satisfies ExportedHandler<MockResendEnv>
