/**
 * Minimal Cloudflare API v4 mock for local dev and tests.
 * Mirrors only the routes used by the `cloudflare_rest` capability and tests.
 */

type MockCloudflareEnv = {
	MOCK_API_TOKEN?: string
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

type BrowserRenderingMarkdownBody = {
	url?: unknown
	html?: unknown
	userAgent?: unknown
	rejectRequestPattern?: unknown
	gotoOptions?: unknown
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

function isAuthorized(request: Request, env: MockCloudflareEnv) {
	const expected = env.MOCK_API_TOKEN?.trim() ?? ''
	if (!expected) return true
	const provided = parseBearerToken(request.headers.get('authorization'))
	return Boolean(provided && provided === expected)
}

function unauthorized() {
	return json(
		{
			success: false,
			errors: [{ code: 10000, message: 'Authentication error' }],
			messages: [],
			result: null,
		},
		{ status: 401 },
	)
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

function handleMeta(request: Request, env: MockCloudflareEnv) {
	return json({
		service: 'cloudflare',
		authorized: isAuthorized(request, env),
		basePath: '/client/v4',
		endpoints: [
			{
				method: 'GET',
				path: '/client/v4/accounts',
				description: 'List accounts',
			},
			{ method: 'GET', path: '/client/v4/zones', description: 'List zones' },
			{
				method: 'GET',
				path: `/client/v4/zones/${fixtureZone.id}/dns_records`,
				description: 'List DNS records',
			},
			{
				method: 'POST',
				path: `/client/v4/zones/${fixtureZone.id}/dns_records`,
				description: 'Create DNS record',
			},
			{
				method: 'POST',
				path: `/client/v4/accounts/${fixtureAccount.id}/browser-rendering/markdown`,
				description: 'Convert a page or HTML snippet to markdown',
			},
		],
	})
}

function handleDashboard() {
	const endpoints: Array<[string, string]> = [
		['GET', '/client/v4/accounts'],
		['GET', '/client/v4/zones'],
		['GET', `/client/v4/zones/${fixtureZone.id}/dns_records`],
		['POST', `/client/v4/zones/${fixtureZone.id}/dns_records`],
		[
			'POST',
			`/client/v4/accounts/${fixtureAccount.id}/browser-rendering/markdown`,
		],
	]
	const rows = endpoints
		.map(
			([method, path]) =>
				`<tr><td><code>${htmlEscape(method)}</code></td><td><code>${htmlEscape(path)}</code></td></tr>`,
		)
		.join('')
	const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Mock: Cloudflare API</title>
<style>body{font-family:system-ui;margin:24px} table{border-collapse:collapse} td,th{border:1px solid #ccc;padding:8px}</style>
</head><body>
<h1>Mock: Cloudflare API</h1>
<p>Meta: <a href="/__mocks/meta">/__mocks/meta</a></p>
<table><thead><tr><th>Method</th><th>Path</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`
	return new Response(body, {
		headers: { 'content-type': 'text/html; charset=utf-8' },
	})
}

async function routeApi(request: Request, env: MockCloudflareEnv, url: URL) {
	if (request.method === 'GET' && url.pathname === '/__mocks/markdown') {
		return new Response('# Mock markdown\n\nServed as markdown.\n', {
			headers: {
				'content-type': 'text/markdown; charset=utf-8',
				'x-markdown-tokens': '8',
			},
		})
	}
	if (request.method === 'GET' && url.pathname === '/__mocks/markdown-error') {
		return new Response('# Mock markdown error\n\nServer error page.\n', {
			status: 500,
			headers: {
				'content-type': 'text/markdown; charset=utf-8',
				'x-markdown-tokens': '9',
			},
		})
	}

	if (!isAuthorized(request, env)) {
		return unauthorized()
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

	const markdownMatch = url.pathname.match(
		/^\/client\/v4\/accounts\/([^/]+)\/browser-rendering\/markdown\/?$/,
	)
	if (markdownMatch && request.method === 'POST') {
		const accountId = markdownMatch[1]!
		const payload = (await readJsonBody(
			request,
		)) as BrowserRenderingMarkdownBody | null
		if (payload === null) {
			return json(
				{
					success: false,
					errors: [{ code: 1001, message: 'invalid JSON body' }],
					messages: [],
					result: null,
				},
				{ status: 400 },
			)
		}
		if (accountId !== fixtureAccount.id) {
			return json(
				{
					success: false,
					errors: [{ code: 1002, message: 'account not found' }],
					messages: [],
					result: null,
				},
				{ status: 404 },
			)
		}
		const hasUrl = typeof payload.url === 'string' && payload.url.trim().length > 0
		const hasHtml =
			typeof payload.html === 'string' && payload.html.trim().length > 0
		if (!hasUrl && !hasHtml) {
			return json(
				{
					success: false,
					errors: [
						{ code: 1003, message: 'Either url or html is required.' },
					],
					messages: [],
					result: null,
				},
				{ status: 400 },
			)
		}
		const mode = hasHtml ? 'html' : 'url'
		const sourceValue = hasHtml
			? String(payload.html).trim()
			: String(payload.url).trim()
		const markdown = [
			'# Mock Browser Rendering',
			'',
			`mode: ${mode}`,
			`source: ${sourceValue}`,
			...(typeof payload.userAgent === 'string' && payload.userAgent.length > 0
				? [`userAgent: ${payload.userAgent}`]
				: []),
		].join('\n')
		return envelope(markdown, { status: 200 })
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
			return json(
				{
					success: false,
					errors: [{ code: 1001, message: 'invalid JSON body' }],
					messages: [],
					result: null,
				},
				{ status: 400 },
			)
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
			return Response.redirect(destination.toString(), 302)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks') {
			return handleDashboard()
		}

		if (request.method === 'GET' && url.pathname === '/__mocks/meta') {
			return handleMeta(request, env)
		}

		const apiResponse = await routeApi(request, env, url)
		if (apiResponse) return apiResponse

		return new Response('Not Found', { status: 404 })
	},
} satisfies ExportedHandler<MockCloudflareEnv>
