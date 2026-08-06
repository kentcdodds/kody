import { expect, test, vi } from 'vitest'
import {
	classifyMcpProtocolRequest,
	recordMcpProtocolEvent,
	type McpProtocolEventEnv,
} from './protocol-metrics.ts'

const mcpUrl = 'https://example.com/mcp'

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
	return new Request(mcpUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...headers,
		},
		body: JSON.stringify(body),
	})
}

test('legacy initialize handshake classifies legacy with client info', async () => {
	const request = jsonRequest({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'claude-ai', version: '0.1.0' },
		},
	})
	const classification = await classifyMcpProtocolRequest(request)
	expect(classification).toMatchObject({
		lane: 'legacy',
		method: 'initialize',
		protocolVersion: '2025-06-18',
		clientName: 'claude-ai',
		clientVersion: '0.1.0',
	})
	// The request body stays readable for the lane that serves it.
	expect(await request.text()).toContain('initialize')
})

test('legacy post-handshake call reports the negotiated header version', async () => {
	const classification = await classifyMcpProtocolRequest(
		jsonRequest(
			{
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'search', arguments: { query: 'email' } },
			},
			{ 'mcp-protocol-version': '2025-03-26' },
		),
	)
	expect(classification).toMatchObject({
		lane: 'legacy',
		method: 'tools/call',
		protocolVersion: '2025-03-26',
		clientName: '',
		clientVersion: '',
	})
})

test('modern envelope request classifies modern', async () => {
	const classification = await classifyMcpProtocolRequest(
		jsonRequest(
			{
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: {
					name: 'search',
					arguments: { query: 'email' },
					_meta: {
						'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						'io.modelcontextprotocol/clientCapabilities': {},
						'io.modelcontextprotocol/clientInfo': {
							name: 'modern-client',
							version: '2.0.0',
						},
					},
				},
			},
			{
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': 'search',
			},
		),
	)
	expect(classification).toMatchObject({
		lane: 'modern',
		method: 'tools/call',
		protocolVersion: '2026-07-28',
		clientName: 'modern-client',
		clientVersion: '2.0.0',
	})
	expect(classification.parsedBody).toMatchObject({ method: 'tools/call' })
})

test('body-less session operations classify legacy http methods', async () => {
	const get = await classifyMcpProtocolRequest(
		new Request(mcpUrl, {
			headers: {
				Accept: 'text/event-stream',
				'mcp-protocol-version': '2025-06-18',
			},
		}),
	)
	expect(get).toMatchObject({
		lane: 'legacy',
		method: 'http:GET',
		protocolVersion: '2025-06-18',
	})

	const del = await classifyMcpProtocolRequest(
		new Request(mcpUrl, { method: 'DELETE' }),
	)
	expect(del).toMatchObject({ lane: 'legacy', method: 'http:DELETE' })
})

test('invalid JSON body classifies legacy without throwing', async () => {
	const classification = await classifyMcpProtocolRequest(
		new Request(mcpUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not json',
		}),
	)
	expect(classification.lane).toBe('legacy')
	expect(classification.method).toBe('unknown')
	expect(classification.parsedBody).toBeUndefined()
})

test('recordMcpProtocolEvent writes one lane data point', () => {
	const writeDataPoint = vi.fn<(point: AnalyticsEngineDataPoint) => void>()
	const env = {
		MCP_PROTOCOL_EVENTS: {
			writeDataPoint,
		} as unknown as AnalyticsEngineDataset,
	} satisfies McpProtocolEventEnv
	recordMcpProtocolEvent(env, {
		lane: 'legacy',
		method: 'tools/call',
		protocolVersion: '2025-06-18',
		clientName: 'claude-ai',
		clientVersion: '0.1.0',
		userId: 'user-1',
	})
	expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
		indexes: ['legacy'],
		blobs: [
			'legacy',
			'tools/call',
			'2025-06-18',
			'claude-ai',
			'0.1.0',
			'user-1',
		],
		doubles: [1],
	})
})

test('recordMcpProtocolEvent is a no-op without the binding and never throws', () => {
	expect(() =>
		recordMcpProtocolEvent(
			{},
			{
				lane: 'modern',
				method: 'tools/list',
				protocolVersion: '2026-07-28',
				clientName: '',
				clientVersion: '',
			},
		),
	).not.toThrow()

	const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		expect(() =>
			recordMcpProtocolEvent(
				{
					MCP_PROTOCOL_EVENTS: {
						writeDataPoint: () => {
							throw new Error('sink offline')
						},
					} as unknown as AnalyticsEngineDataset,
				},
				{
					lane: 'modern',
					method: 'tools/list',
					protocolVersion: '2026-07-28',
					clientName: '',
					clientVersion: '',
				},
			),
		).not.toThrow()
		expect(consoleWarn).toHaveBeenCalledWith(
			'mcp-protocol-event-failed',
			expect.any(Error),
		)
	} finally {
		consoleWarn.mockRestore()
	}
})
