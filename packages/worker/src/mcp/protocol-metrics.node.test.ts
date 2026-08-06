import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
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

test('classifyMcpProtocolRequest covers legacy, modern, and failure paths', async () => {
	const initializeRequest = jsonRequest({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'claude-ai', version: '0.1.0' },
		},
	})
	expect(await classifyMcpProtocolRequest(initializeRequest)).toMatchObject({
		lane: 'legacy',
		method: 'initialize',
		protocolVersion: '2025-06-18',
		clientName: 'claude-ai',
		clientVersion: '0.1.0',
	})
	// The request body stays readable for the lane that serves it.
	expect(await initializeRequest.text()).toContain('initialize')

	expect(
		await classifyMcpProtocolRequest(
			jsonRequest(
				{
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'search', arguments: { query: 'email' } },
				},
				{ 'mcp-protocol-version': '2025-03-26' },
			),
		),
	).toMatchObject({
		lane: 'legacy',
		method: 'tools/call',
		protocolVersion: '2025-03-26',
		clientName: '',
		clientVersion: '',
	})

	const modern = await classifyMcpProtocolRequest(
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
	expect(modern).toMatchObject({
		lane: 'modern',
		method: 'tools/call',
		protocolVersion: '2026-07-28',
		clientName: 'modern-client',
		clientVersion: '2.0.0',
	})
	expect(modern.parsedBody).toMatchObject({ method: 'tools/call' })

	expect(
		await classifyMcpProtocolRequest(
			new Request(mcpUrl, {
				headers: {
					Accept: 'text/event-stream',
					'mcp-protocol-version': '2025-06-18',
				},
			}),
		),
	).toMatchObject({
		lane: 'legacy',
		method: 'http:GET',
		protocolVersion: '2025-06-18',
	})
	expect(
		await classifyMcpProtocolRequest(new Request(mcpUrl, { method: 'DELETE' })),
	).toMatchObject({ lane: 'legacy', method: 'http:DELETE' })

	const invalid = await classifyMcpProtocolRequest(
		new Request(mcpUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not json',
		}),
	)
	expect(invalid.lane).toBe('legacy')
	expect(invalid.method).toBe('unknown')
	expect(invalid.parsedBody).toBeUndefined()
})

test('recordMcpProtocolEvent writes a data point, no-ops without binding, and swallows sink errors', () => {
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

	consoleWarn.mockImplementation(() => {})
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
})
