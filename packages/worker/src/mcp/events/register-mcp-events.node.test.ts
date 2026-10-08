import {
	Client,
	type ClientCapabilities,
	StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { afterEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type FeatureFlagKey } from '#universal/feature-flags/registry.ts'
import {
	clientSupportsMcpEvents,
	readMcpRequestClientCapabilities,
	registerMcpEvents,
} from './register-mcp-events.ts'

const mocks = vi.hoisted(() => ({
	resolveCallerFeatureFlags: vi.fn(),
	listMcpEventSources: vi.fn(),
}))

vi.mock('#mcp/capabilities/access-control.ts', () => ({
	resolveCallerFeatureFlags: (...args: Array<unknown>) =>
		mocks.resolveCallerFeatureFlags(...args),
}))

vi.mock('./list-events.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	listMcpEventSources: (...args: Array<unknown>) =>
		mocks.listMcpEventSources(...args),
}))

const callerContext = createMcpCallerContext({
	baseUrl: 'https://kody.example.com',
	user: {
		userId: 'stable-user-1',
		email: 'one@example.com',
		displayName: 'One',
	},
})

const eventsExtensionCapabilities: ClientCapabilities = {
	extensions: { 'io.modelcontextprotocol/events': {} },
}

const eventsListResultSchema = z.object({
	events: z.array(z.object({ name: z.string() }).loose()),
})

function flags(enabled: boolean): Record<FeatureFlagKey, boolean> {
	return {
		'demo-indicator': false,
		'package-share-grants': false,
		'jev-search-rerank': false,
		'execute-invoke': false,
		'connection-profiles': false,
		'mcp-events-extension': enabled,
	}
}

async function connectModernClient(input: {
	clientCapabilities?: ClientCapabilities
	oauthClientId?: string | null
}) {
	const registered: Array<boolean> = []
	const discoverCapabilities: Array<unknown> = []
	let parsedBody: unknown
	const handler = createMcpHandler(
		async () => {
			const server = new McpServer({ name: 'kody-mcp', version: '1.0.0' })
			registered.push(
				await registerMcpEvents({
					server,
					env: { APP_DB: {} } as Env,
					callerContext,
					oauthClientId:
						input.oauthClientId === undefined
							? 'client-a'
							: input.oauthClientId,
					clientCapabilities: readMcpRequestClientCapabilities(parsedBody),
				}),
			)
			return server
		},
		{ legacy: 'reject' },
	)
	const client = new Client(
		{ name: 'events-test-client', version: '1.0.0' },
		{
			versionNegotiation: { mode: { pin: '2026-07-28' } },
			...(input.clientCapabilities
				? { capabilities: input.clientCapabilities }
				: {}),
		},
	)
	const transport = new StreamableHTTPClientTransport(
		new URL('https://kody.example.com/mcp'),
		{
			fetch: async (url, init) => {
				const request = new Request(url, init)
				parsedBody = await request.clone().json()
				const response = await handler.fetch(request, { parsedBody })
				// The client's typed ServerCapabilities strips unknown keys, so
				// read the advertised capabilities off the wire.
				if (request.headers.get('Mcp-Method') === 'server/discover') {
					const body = (await response.clone().json()) as {
						result?: { capabilities?: unknown }
					}
					discoverCapabilities.push(body.result?.capabilities)
				}
				return response
			},
		},
	)
	await client.connect(transport)
	return {
		client,
		registered,
		discoverCapabilities,
		async listEvents() {
			return await client.request(
				{ method: 'events/list', params: {} },
				eventsListResultSchema,
			)
		},
		async [Symbol.asyncDispose]() {
			await client.close().catch(() => undefined)
		},
	}
}

async function expectMethodNotFound(promise: Promise<unknown>) {
	await expect(promise).rejects.toMatchObject({
		data: { text: expect.stringContaining('"code":-32601') },
	})
}

afterEach(() => {
	mocks.resolveCallerFeatureFlags.mockReset()
	mocks.listMcpEventSources.mockReset()
})

test('flag off: no events capability and events/* methods are not found', async () => {
	mocks.resolveCallerFeatureFlags.mockResolvedValue(flags(false))
	await using connection = await connectModernClient({
		clientCapabilities: eventsExtensionCapabilities,
	})

	expect(connection.registered.every((value) => value === false)).toBe(true)
	expect(connection.discoverCapabilities).not.toHaveLength(0)
	for (const capabilities of connection.discoverCapabilities) {
		expect(capabilities).not.toHaveProperty('events')
	}
	await expectMethodNotFound(connection.listEvents())
	expect(mocks.listMcpEventSources).not.toHaveBeenCalled()
})

test('flag on without a client events capability registers nothing and skips the flag lookup', async () => {
	mocks.resolveCallerFeatureFlags.mockResolvedValue(flags(true))
	await using connection = await connectModernClient({})

	expect(connection.registered.every((value) => value === false)).toBe(true)
	expect(connection.discoverCapabilities).not.toHaveLength(0)
	for (const capabilities of connection.discoverCapabilities) {
		expect(capabilities).not.toHaveProperty('events')
	}
	await expectMethodNotFound(connection.listEvents())
	expect(mocks.resolveCallerFeatureFlags).not.toHaveBeenCalled()
})

test('flag on with a non-OAuth caller registers nothing', async () => {
	mocks.resolveCallerFeatureFlags.mockResolvedValue(flags(true))
	await using connection = await connectModernClient({
		clientCapabilities: eventsExtensionCapabilities,
		oauthClientId: null,
	})

	expect(connection.registered.every((value) => value === false)).toBe(true)
	await expectMethodNotFound(connection.listEvents())
})

test('flag on and client capability advertises events and serves events/list', async () => {
	mocks.resolveCallerFeatureFlags.mockResolvedValue(flags(true))
	mocks.listMcpEventSources.mockResolvedValue(
		new Map([
			[
				'@kentcdodds/discord.message.created',
				{
					definition: {
						name: '@kentcdodds/discord.message.created',
						description: 'A Discord message was created.',
						delivery: ['webhook'],
						inputSchema: {
							type: 'object',
							properties: {},
							additionalProperties: false,
						},
						payloadSchema: { type: 'object' },
					},
					packageIds: ['pkg-1'],
				},
			],
		]),
	)
	await using connection = await connectModernClient({
		clientCapabilities: eventsExtensionCapabilities,
	})

	expect(connection.registered.at(-1)).toBe(true)
	expect(connection.discoverCapabilities.at(-1)).toMatchObject({
		events: {},
	})
	await expect(connection.listEvents()).resolves.toEqual({
		events: [
			{
				name: '@kentcdodds/discord.message.created',
				description: 'A Discord message was created.',
				delivery: ['webhook'],
				inputSchema: {
					type: 'object',
					properties: {},
					additionalProperties: false,
				},
				payloadSchema: { type: 'object' },
			},
		],
	})
	expect(mocks.listMcpEventSources).toHaveBeenCalledWith({
		env: expect.anything(),
		callerContext,
	})
})

test('clientSupportsMcpEvents accepts each declaration shape in circulation', () => {
	expect(clientSupportsMcpEvents(null)).toBe(false)
	expect(clientSupportsMcpEvents({})).toBe(false)
	expect(clientSupportsMcpEvents({ events: {} })).toBe(true)
	expect(clientSupportsMcpEvents({ experimental: { events: {} } })).toBe(true)
	expect(
		clientSupportsMcpEvents({
			extensions: { 'io.modelcontextprotocol/events': {} },
		}),
	).toBe(true)
	expect(clientSupportsMcpEvents({ events: true })).toBe(false)
	expect(
		readMcpRequestClientCapabilities({
			jsonrpc: '2.0',
			id: 1,
			method: 'server/discover',
			params: {
				_meta: {
					'io.modelcontextprotocol/clientCapabilities': { events: {} },
				},
			},
		}),
	).toEqual({ events: {} })
	expect(readMcpRequestClientCapabilities({ params: {} })).toBeNull()
})
