import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { expect, test } from 'vitest'
import {
	Client,
	StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { reconnectMcpServerOptions } from './reconnect.ts'
import { withStaticTransportHeaders } from './transport-headers.ts'

const bearerToken = 'test-token'

test('Kody-as-client lists tools on modern-only and 2025 initialize servers', async () => {
	await using modern = await startRecordedServer(createModernOnlyHandler())
	await using legacy = await startRecordedServer(
		createInitializeHandler({ name: 'home', toolName: 'home_ping' }),
	)

	expect(
		await listToolNamesAsKody(modern.origin, {
			headers: { Authorization: `Bearer ${bearerToken}` },
			staleSession: {
				sessionId: 'stale-2025-session',
				protocolVersion: '2025-11-25',
			},
		}),
	).toEqual(['list_feeds'])
	expect(rpcMethods(modern.recorded)).toContain('server/discover')
	expect(rpcMethods(modern.recorded)).not.toContain('initialize')
	expect(modern.recorded.some((entry) => entry.httpMethod === 'DELETE')).toBe(
		false,
	)

	expect(await listToolNamesAsKody(legacy.origin)).toEqual(['home_ping'])
	expect(rpcMethods(legacy.recorded)).toContain('initialize')
	expect(rpcMethods(legacy.recorded)).toContain('tools/list')
})

test('modern connect then catalog hang is recoverable on the same server via legacy initialize', async () => {
	await using stalling = await startRecordedServer(
		createInitializeHandler({
			name: 'stalling',
			toolName: 'catalog_ping',
			hangModernCatalog: true,
		}),
	)

	await expect(
		listToolNamesAsKody(stalling.origin, { timeout: 250 }),
	).rejects.toThrow()
	expect(rpcMethods(stalling.recorded)).toContain('server/discover')
	expect(rpcMethods(stalling.recorded)).toContain('tools/list')
	expect(rpcMethods(stalling.recorded)).not.toContain('initialize')

	expect(
		await listToolNamesAsKody(stalling.origin, { mode: 'legacy' }),
	).toEqual(['catalog_ping'])
	expect(rpcMethods(stalling.recorded)).toContain('initialize')
})

async function listToolNamesAsKody(
	origin: string,
	input?: {
		headers?: Record<string, string>
		staleSession?: { sessionId: string; protocolVersion: string }
		mode?: 'auto' | 'legacy'
		timeout?: number
	},
) {
	const reconnected = reconnectMcpServerOptions(
		{
			transport: {
				type: 'auto',
				...input?.staleSession,
				...(input?.headers ? { headers: input.headers } : {}),
			},
			discoverResult: input?.staleSession
				? { supportedVersions: ['2025-11-25'] }
				: undefined,
		},
		input?.mode ?? 'auto',
	)
	expect(reconnected.transport.sessionId).toBeUndefined()
	expect(reconnected.transport.protocolVersion).toBeUndefined()

	const client = new Client(
		{ name: 'Kody', version: '1.0.0' },
		{ versionNegotiation: { mode: input?.mode ?? 'auto' } },
	)
	const headers = withStaticTransportHeaders(reconnected.transport)
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
		requestInit: headers.requestInit,
	})
	await client.connect(transport)
	try {
		const listed = await client.listTools(
			undefined,
			input?.timeout ? { timeout: input.timeout } : undefined,
		)
		return listed.tools.map((tool) => tool.name)
	} finally {
		await client.close().catch(() => undefined)
		await transport.close().catch(() => undefined)
	}
}

function createModernOnlyHandler() {
	const mcpHandler = createMcpHandler(
		() => {
			const server = new McpServer({ name: 'mediarss', version: '1.0.0' })
			server.registerTool(
				'list_feeds',
				{ description: 'List saved feeds' },
				() => ({
					content: [{ type: 'text', text: '[]' }],
				}),
			)
			return server
		},
		{ legacy: 'reject' },
	)
	return async (request: Request) => {
		if (request.headers.get('authorization') !== `Bearer ${bearerToken}`) {
			return new Response('Unauthorized', {
				status: 401,
				headers: { 'WWW-Authenticate': 'Bearer' },
			})
		}
		return mcpHandler.fetch(request)
	}
}

/**
 * Hand-rolled 2025 `initialize` server. With `hangModernCatalog`, it also
 * answers modern `server/discover` but stalls `tools/list` until a legacy
 * `initialize` has happened.
 */
function createInitializeHandler(input: {
	name: string
	toolName: string
	hangModernCatalog?: boolean
}) {
	let sawInitialize = false
	const serverInfo = { name: input.name, version: '1.0.0' }
	return async (request: Request) => {
		if (request.method === 'DELETE') {
			return new Response(null, { status: 200 })
		}
		if (request.method !== 'POST') {
			return new Response(null, { status: 405 })
		}
		const { id = null, method } = (await request.json()) as {
			id?: string | number
			method?: string
		}
		const reply = (payload: object, init?: ResponseInit) =>
			Response.json({ jsonrpc: '2.0', id, ...payload }, init)
		if (method === 'server/discover' && input.hangModernCatalog) {
			return reply({
				result: {
					protocolVersion: '2026-07-28',
					supportedVersions: ['2026-07-28'],
					capabilities: { tools: {} },
					serverInfo,
				},
			})
		}
		if (method === 'initialize') {
			sawInitialize = true
			return reply(
				{
					result: {
						protocolVersion: '2025-11-25',
						capabilities: { tools: {} },
						serverInfo,
					},
				},
				{ headers: { 'mcp-session-id': `${input.name}-session-1` } },
			)
		}
		if (method === 'notifications/initialized') {
			return new Response(null, { status: 202 })
		}
		if (method === 'tools/list') {
			if (input.hangModernCatalog && !sawInitialize) {
				await new Promise((resolve) => setTimeout(resolve, 400))
				return new Response(null, { status: 504 })
			}
			return reply({
				result: {
					tools: [
						{
							name: input.toolName,
							inputSchema: { type: 'object', properties: {} },
						},
					],
				},
			})
		}
		return reply({ error: { code: -32601, message: 'Method not found' } })
	}
}

type RecordedRequest = {
	httpMethod: string
	rpcMethod?: string
}

async function startRecordedServer(
	handle: (request: Request) => Promise<Response>,
) {
	const recorded: Array<RecordedRequest> = []
	const server = createServer((req, res) => {
		void dispatchRecordedRequest({ req, res, recorded, handle }).catch(
			(error: unknown) => {
				res.statusCode = 500
				res.end(error instanceof Error ? error.message : String(error))
			},
		)
	})
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address()
	if (typeof address !== 'object' || address === null) {
		throw new Error('Recorded MCP server did not bind a TCP port.')
	}
	const origin = `http://127.0.0.1:${String(address.port)}`
	return {
		origin,
		recorded,
		async [Symbol.asyncDispose]() {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			})
		},
	}
}

async function dispatchRecordedRequest(input: {
	req: IncomingMessage
	res: ServerResponse
	recorded: Array<RecordedRequest>
	handle: (request: Request) => Promise<Response>
}) {
	const chunks: Array<Buffer> = []
	for await (const chunk of input.req) {
		chunks.push(Buffer.from(chunk))
	}
	const body = Buffer.concat(chunks)
	const host = input.req.headers.host ?? '127.0.0.1'
	const url = new URL(input.req.url ?? '/', `http://${host}`)
	const headers = new Headers()
	for (const [key, value] of Object.entries(input.req.headers)) {
		if (typeof value === 'string') headers.set(key, value)
		else if (Array.isArray(value)) headers.set(key, value.join(', '))
	}
	let rpcMethod: string | undefined
	if (body.length > 0) {
		try {
			const parsed = JSON.parse(body.toString()) as { method?: string }
			rpcMethod = typeof parsed.method === 'string' ? parsed.method : undefined
		} catch {
			rpcMethod = undefined
		}
	}
	input.recorded.push({
		httpMethod: input.req.method ?? 'GET',
		...(rpcMethod ? { rpcMethod } : {}),
	})
	const request = new Request(url, {
		method: input.req.method,
		headers,
		...(body.length > 0
			? ({ body, duplex: 'half' } satisfies RequestInit & { duplex: 'half' })
			: {}),
	})
	const response = await input.handle(request)
	input.res.statusCode = response.status
	response.headers.forEach((value, key) => {
		input.res.setHeader(key, value)
	})
	input.res.end(Buffer.from(await response.arrayBuffer()))
}

function rpcMethods(recorded: Array<RecordedRequest>) {
	return recorded.flatMap((entry) => (entry.rpcMethod ? [entry.rpcMethod] : []))
}
