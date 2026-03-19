/**
 * Minimal Cursor Cloud Agents API mock for local dev and tests.
 * Subset of https://cursor.com/docs/cloud-agent/api/endpoints
 */

type MockCursorEnv = {
	MOCK_API_TOKEN?: string
}

type AgentRecord = {
	id: string
	name: string
	status: string
	source: { repository: string; ref?: string }
	target: {
		branchName?: string
		url: string
		prUrl?: string
		autoCreatePr: boolean
		openAsCursorGithubApp: boolean
		skipReviewerRequest: boolean
	}
	summary?: string
	createdAt: string
}

/** In-memory store (sufficient for local wrangler dev + tests). */
const agentsById = new Map<string, AgentRecord>()
let agentSeq = 0

const fixtureAgentId = 'bc_mock_42'

function isoNow() {
	return new Date().toISOString()
}

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

/** Cursor API: Basic auth with API key as username and empty password (curl -u KEY:). */
function parseBasicApiKey(headerValue: string | null): string | null {
	if (!headerValue) return null
	const match = headerValue.match(/^Basic\s+(\S+)\s*$/i)
	if (!match?.[1]) return null
	try {
		const decoded = atob(match[1])
		const colon = decoded.indexOf(':')
		if (colon === -1) return decoded.trim() || null
		return decoded.slice(0, colon).trim() || null
	} catch {
		return null
	}
}

function isAuthorized(request: Request, env: MockCursorEnv) {
	const expected = env.MOCK_API_TOKEN?.trim() ?? ''
	if (!expected) return true
	const provided = parseBasicApiKey(request.headers.get('authorization'))
	return Boolean(provided && provided === expected)
}

function unauthorized() {
	return json({ error: 'unauthorized' }, { status: 401 })
}

function seedFixtureIfEmpty() {
	if (agentsById.size > 0) return
	agentsById.set(fixtureAgentId, {
		id: fixtureAgentId,
		name: 'Mock: README tweak',
		status: 'FINISHED',
		source: {
			repository: 'https://github.com/kentcdodds/kody',
			ref: 'main',
		},
		target: {
			branchName: 'cursor/mock-readme',
			url: `https://cursor.com/agents?id=${fixtureAgentId}`,
			prUrl: 'https://github.com/kentcdodds/kody/pull/42',
			autoCreatePr: false,
			openAsCursorGithubApp: false,
			skipReviewerRequest: false,
		},
		summary: 'Mock cloud agent for `cursor_cloud_rest` tests.',
		createdAt: '2025-01-15T10:30:00.000Z',
	})
}

function nextId() {
	agentSeq += 1
	return `bc_mock_${agentSeq}`
}

async function handleListAgents(_request: Request, url: URL) {
	seedFixtureIfEmpty()
	const limitRaw = url.searchParams.get('limit')
	const limit = limitRaw
		? Math.min(100, Math.max(1, Number.parseInt(limitRaw, 10) || 20))
		: 20
	const prUrl = url.searchParams.get('prUrl')?.trim()

	let list = [...agentsById.values()]
	if (prUrl) {
		list = list.filter((a) => a.target.prUrl === prUrl)
	}
	list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

	const slice = list.slice(0, limit)
	const nextCursor =
		list.length > limit ? (slice[slice.length - 1]?.id ?? null) : null

	return json({
		agents: slice,
		...(nextCursor ? { nextCursor } : {}),
	})
}

function handleGetAgent(id: string) {
	seedFixtureIfEmpty()
	const agent = agentsById.get(id)
	if (!agent) {
		return json({ error: 'not_found' }, { status: 404 })
	}
	return json(agent)
}

async function handleLaunchAgent(request: Request) {
	seedFixtureIfEmpty()
	let payload: Record<string, unknown> = {}
	try {
		const text = await request.text()
		if (text.trim()) {
			payload = JSON.parse(text) as Record<string, unknown>
		}
	} catch {
		return json({ error: 'invalid_json' }, { status: 400 })
	}

	const prompt = payload.prompt as { text?: string } | undefined
	const source = payload.source as
		| { repository?: string; ref?: string }
		| undefined
	const target = (payload.target ?? {}) as Record<string, unknown>

	const id = nextId()
	const name =
		typeof prompt?.text === 'string' && prompt.text.trim()
			? prompt.text.trim().slice(0, 80)
			: 'Mock launched agent'

	const repository =
		typeof source?.repository === 'string' && source.repository.trim()
			? source.repository.trim()
			: 'https://github.com/kentcdodds/kody'

	const record: AgentRecord = {
		id,
		name,
		status: 'CREATING',
		source: {
			repository,
			...(typeof source?.ref === 'string' ? { ref: source.ref } : {}),
		},
		target: {
			branchName:
				typeof target.branchName === 'string'
					? target.branchName
					: `cursor/mock-${id}`,
			url: `https://cursor.com/agents?id=${id}`,
			prUrl: typeof target.prUrl === 'string' ? target.prUrl : undefined,
			autoCreatePr: Boolean(target.autoCreatePr),
			openAsCursorGithubApp: Boolean(target.openAsCursorGithubApp),
			skipReviewerRequest: Boolean(target.skipReviewerRequest),
		},
		createdAt: isoNow(),
	}

	agentsById.set(id, record)

	return json(record)
}

function handleStopAgent(id: string) {
	seedFixtureIfEmpty()
	const agent = agentsById.get(id)
	if (!agent) {
		return json({ error: 'not_found' }, { status: 404 })
	}
	if (agent.status === 'RUNNING' || agent.status === 'CREATING') {
		agent.status = 'STOPPED'
	}
	return json({ id })
}

async function handleGetMeta() {
	return json({
		service: 'cursor-cloud-agents',
		endpoints: [
			{ method: 'GET', path: '/v0/agents', description: 'List agents' },
			{ method: 'GET', path: '/v0/agents/:id', description: 'Agent status' },
			{ method: 'POST', path: '/v0/agents', description: 'Launch agent' },
			{
				method: 'POST',
				path: '/v0/agents/:id/stop',
				description: 'Stop agent',
			},
			{ method: 'GET', path: '/v0/me', description: 'API key info' },
			{ method: 'GET', path: '/v0/models', description: 'List models' },
		],
	})
}

async function handleDashboard(_url: URL) {
	const rowPairs: Array<[string, string]> = [
		['GET', '/v0/agents'],
		['GET', `/v0/agents/${fixtureAgentId}`],
		['POST', '/v0/agents'],
		['POST', `/v0/agents/${fixtureAgentId}/stop`],
		['GET', '/v0/me'],
		['GET', '/v0/models'],
	]
	const rows = rowPairs
		.map(
			([method, path]) =>
				`<tr><td><code>${htmlEscape(method)}</code></td><td><code>${htmlEscape(path)}</code></td></tr>`,
		)
		.join('')

	const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Mock: Cursor Cloud Agents</title>
<style>body{font-family:system-ui;margin:24px} table{border-collapse:collapse} td,th{border:1px solid #ccc;padding:8px}</style>
</head><body>
<h1>Mock: Cursor Cloud Agents API</h1>
<p>Meta: <a href="/__mocks/meta">/__mocks/meta</a></p>
<table><thead><tr><th>Method</th><th>Path</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`
	return new Response(body, {
		headers: { 'content-type': 'text/html; charset=utf-8' },
	})
}

function routeApi(
	request: Request,
	env: MockCursorEnv,
	url: URL,
): Response | Promise<Response> | null {
	if (!isAuthorized(request, env)) {
		return unauthorized()
	}

	const pathname = url.pathname

	if (request.method === 'GET' && pathname === '/v0/me') {
		return json({
			apiKeyName: 'Mock Cursor API Key',
			createdAt: '2025-01-15T10:30:00.000Z',
			userEmail: 'mock@kody.dev',
		})
	}

	if (request.method === 'GET' && pathname === '/v0/models') {
		return json({
			models: ['claude-4-sonnet-thinking', 'gpt-5.2'],
		})
	}

	if (request.method === 'GET' && pathname === '/v0/agents') {
		return handleListAgents(request, url)
	}

	const launchMatch = pathname.match(/^\/v0\/agents\/?$/)
	if (request.method === 'POST' && launchMatch) {
		return handleLaunchAgent(request)
	}

	const getOneMatch = pathname.match(/^\/v0\/agents\/([^/]+)\/?$/)
	if (request.method === 'GET' && getOneMatch) {
		return handleGetAgent(getOneMatch[1]!)
	}

	const stopMatch = pathname.match(/^\/v0\/agents\/([^/]+)\/stop\/?$/)
	if (request.method === 'POST' && stopMatch) {
		return handleStopAgent(stopMatch[1]!)
	}

	return null
}

export default {
	async fetch(request: Request, env: MockCursorEnv, ctx: ExecutionContext) {
		void ctx
		const url = new URL(request.url)

		if (request.method === 'GET' && url.pathname === '/') {
			const destination = new URL('/__mocks', url)
			destination.search = url.search
			return Response.redirect(destination.toString(), 302)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks') {
			return handleDashboard(url)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks/meta') {
			return handleGetMeta()
		}

		const apiResponse = routeApi(request, env, url)
		if (apiResponse) return await apiResponse

		return new Response('Not Found', { status: 404 })
	},
} satisfies ExportedHandler<MockCursorEnv>
