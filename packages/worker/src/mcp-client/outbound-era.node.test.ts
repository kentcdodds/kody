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
	await using legacy = await startRecordedServer(createInitializeOnlyHandler())

	const modernClient = await connectKodyAsClient(modern.origin, {
		headers: { Authorization: `Bearer ${bearerToken}` },
		staleSession: {
			sessionId: 'stale-2025-session',
			protocolVersion: '2025-11-25',
		},
	})
	try {
		const modernTools = await modernClient.client.listTools()
		expect(modernTools.tools.map((tool) => tool.name)).toEqual(['list_feeds'])
	} finally {
		await modernClient.client.close().catch(() => undefined)
		await modernClient.transport.close().catch(() => undefined)
	}

	expect(rpcMethods(modern.recorded)).toContain('server/discover')
	expect(rpcMethods(modern.recorded)).not.toContain('initialize')
	expect(modern.recorded.some((entry) => entry.httpMethod === 'DELETE')).toBe(
		false,
	)

	const legacyClient = await connectKodyAsClient(legacy.origin)
	try {
		const legacyTools = await legacyClient.client.listTools()
		expect(legacyTools.tools.map((tool) => tool.name)).toEqual(['home_ping'])
	} finally {
		await legacyClient.client.close().catch(() => undefined)
		await legacyClient.transport.close().catch(() => undefined)
	}

	expect(rpcMethods(legacy.recorded)).toContain('initialize')
	expect(rpcMethods(legacy.recorded)).toContain('tools/list')
})

async function connectKodyAsClient(
	origin: string,
	input?: {
		headers?: Record<string, string>
		staleSession?: { sessionId: string; protocolVersion: string }
	},
) {
	const reconnected = reconnectMcpServerOptions({
		transport: {
			type: 'auto',
			...input?.staleSession,
			...(input?.headers ? { headers: input.headers } : {}),
		},
		discoverResult: input?.staleSession
			? { supportedVersions: ['2025-11-25'] }
			: undefined,
	})
	expect(reconnected.transport.sessionId).toBeUndefined()
	expect(reconnected.transport.protocolVersion).toBeUndefined()

	const client = new Client(
		{ name: 'Kody', version: '1.0.0' },
		{ versionNegotiation: { mode: 'auto' } },
	)
	const headers = withStaticTransportHeaders(reconnected.transport)
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
		requestInit: headers.requestInit,
	})
	await client.connect(transport)
	return { client, transport }
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

function createInitializeOnlyHandler() {
	return async (request: Request) => {
		if (request.method === 'DELETE') {
			return new Response(null, { status: 200 })
		}
		if (request.method !== 'POST') {
			return new Response(null, { status: 405 })
		}
		const body = (await request.json()) as {
			id?: string | number
			method?: string
		}
		if (body.method === 'initialize') {
			return Response.json(
				{
					jsonrpc: '2.0',
					id: body.id ?? null,
					result: {
						protocolVersion: '2025-11-25',
						capabilities: { tools: {} },
						serverInfo: { name: 'home', version: '1.0.0' },
					},
				},
				{ headers: { 'mcp-session-id': 'home-session-1' } },
			)
		}
		if (body.method === 'notifications/initialized') {
			return new Response(null, { status: 202 })
		}
		if (body.method === 'tools/list') {
			return Response.json({
				jsonrpc: '2.0',
				id: body.id ?? null,
				result: {
					tools: [
						{
							name: 'home_ping',
							inputSchema: { type: 'object', properties: {} },
						},
					],
				},
			})
		}
		return Response.json({
			jsonrpc: '2.0',
			id: body.id ?? null,
			error: { code: -32601, message: 'Method not found' },
		})
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
