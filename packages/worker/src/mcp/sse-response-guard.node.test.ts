import { describe, expect, test } from 'vitest'
import {
	extractJsonRpcRequestIds,
	guardLegacyLaneSseResponse,
} from './sse-response-guard.ts'

describe('extractJsonRpcRequestIds', () => {
	test('extracts IDs from a single request message', () => {
		expect(
			extractJsonRpcRequestIds({
				jsonrpc: '2.0',
				method: 'tools/call',
				id: 42,
				params: { name: 'execute' },
			}),
		).toEqual([42])
	})

	test('extracts IDs from a batch of requests', () => {
		expect(
			extractJsonRpcRequestIds([
				{ jsonrpc: '2.0', method: 'tools/call', id: 1, params: {} },
				{ jsonrpc: '2.0', method: 'tools/call', id: 'abc', params: {} },
			]),
		).toEqual([1, 'abc'])
	})

	test('skips notifications (no id)', () => {
		expect(
			extractJsonRpcRequestIds([
				{ jsonrpc: '2.0', method: 'tools/call', id: 1, params: {} },
				{ jsonrpc: '2.0', method: 'notifications/progress', params: {} },
			]),
		).toEqual([1])
	})

	test('skips response messages (no method)', () => {
		expect(
			extractJsonRpcRequestIds([
				{ jsonrpc: '2.0', id: 1, result: {} },
				{ jsonrpc: '2.0', method: 'tools/call', id: 2, params: {} },
			]),
		).toEqual([2])
	})

	test('returns empty array for undefined body', () => {
		expect(extractJsonRpcRequestIds(undefined)).toEqual([])
	})

	test('returns empty array for non-object body', () => {
		expect(extractJsonRpcRequestIds('not json')).toEqual([])
	})
})

function createSseResponse(events: Array<string>): Response {
	const body = events.join('')
	return new Response(body, {
		status: 200,
		headers: { 'Content-Type': 'text/event-stream' },
	})
}

function formatSseEvent(payload: unknown): string {
	return `event: message\ndata: ${JSON.stringify(payload)}\n\n`
}

async function readFullResponse(response: Response): Promise<string> {
	return response.text()
}

function parseSsePayloads(text: string): Array<unknown> {
	const payloads: Array<unknown> = []
	for (const line of text.split('\n')) {
		if (line.startsWith('data: ')) {
			try {
				payloads.push(JSON.parse(line.slice(6)))
			} catch {
				// skip non-JSON lines
			}
		}
	}
	return payloads
}

describe('guardLegacyLaneSseResponse', () => {
	test('passes through non-SSE responses unchanged', async () => {
		const response = new Response(JSON.stringify({ error: 'bad' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		})
		const guarded = guardLegacyLaneSseResponse([1], response)
		expect(guarded).toBe(response)
	})

	test('passes through 202 responses unchanged', async () => {
		const response = new Response(null, { status: 202 })
		const guarded = guardLegacyLaneSseResponse([1], response)
		expect(guarded).toBe(response)
	})

	test('passes through when no request IDs', async () => {
		const response = createSseResponse([])
		const guarded = guardLegacyLaneSseResponse([], response)
		expect(guarded).toBe(response)
	})

	test('passes through SSE unchanged when all IDs are answered', async () => {
		const events = [
			formatSseEvent({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
			formatSseEvent({ jsonrpc: '2.0', id: 2, result: { content: [] } }),
		]
		const response = createSseResponse(events)
		const guarded = guardLegacyLaneSseResponse([1, 2], response)
		const text = await readFullResponse(guarded)
		const payloads = parseSsePayloads(text)

		expect(payloads).toHaveLength(2)
		expect(payloads).toEqual([
			{ jsonrpc: '2.0', id: 1, result: { content: [] } },
			{ jsonrpc: '2.0', id: 2, result: { content: [] } },
		])
	})

	test('injects error for orphaned request ID when stream ends without response', async () => {
		const response = createSseResponse([': keepalive\n\n'])
		const guarded = guardLegacyLaneSseResponse([42], response)
		const text = await readFullResponse(guarded)
		const payloads = parseSsePayloads(text)

		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toEqual({
			jsonrpc: '2.0',
			id: 42,
			error: {
				code: -32603,
				message:
					'Internal error: the server connection closed before delivering a response. Please retry.',
			},
		})
	})

	test('injects errors only for unanswered IDs in a batch', async () => {
		const events = [
			formatSseEvent({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
		]
		const response = createSseResponse(events)
		const guarded = guardLegacyLaneSseResponse([1, 2, 3], response)
		const text = await readFullResponse(guarded)
		const payloads = parseSsePayloads(text)

		expect(payloads).toHaveLength(3)
		expect(payloads[0]).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: { content: [] },
		})
		const injected = payloads.slice(1) as Array<{
			id: number
			error: { code: number }
		}>
		const injectedIds = injected.map((p) => p.id).sort()
		expect(injectedIds).toEqual([2, 3])
		for (const p of injected) {
			expect(p.error.code).toBe(-32603)
		}
	})

	test('counts error responses as answering a request ID', async () => {
		const events = [
			formatSseEvent({
				jsonrpc: '2.0',
				id: 1,
				error: { code: -32602, message: 'Invalid params' },
			}),
		]
		const response = createSseResponse(events)
		const guarded = guardLegacyLaneSseResponse([1], response)
		const text = await readFullResponse(guarded)
		const payloads = parseSsePayloads(text)

		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toEqual({
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32602, message: 'Invalid params' },
		})
	})

	test('handles string request IDs', async () => {
		const guarded = guardLegacyLaneSseResponse(
			['req-abc'],
			new Response('', {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			}),
		)
		const text = await readFullResponse(guarded)
		const payloads = parseSsePayloads(text)

		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toEqual({
			jsonrpc: '2.0',
			id: 'req-abc',
			error: {
				code: -32603,
				message:
					'Internal error: the server connection closed before delivering a response. Please retry.',
			},
		})
	})

	test('handles chunked SSE where event spans multiple reads', async () => {
		const fullEvent = formatSseEvent({
			jsonrpc: '2.0',
			id: 1,
			result: { ok: true },
		})
		const mid = Math.floor(fullEvent.length / 2)
		const chunk1 = fullEvent.slice(0, mid)
		const chunk2 = fullEvent.slice(mid)

		const encoder = new TextEncoder()
		const { readable, writable } = new TransformStream<Uint8Array>()
		const writer = writable.getWriter()

		const writeChunks = async () => {
			await writer.write(encoder.encode(chunk1))
			await writer.write(encoder.encode(chunk2))
			await writer.close()
		}
		writeChunks().catch(() => {})

		const response = new Response(readable, {
			status: 200,
			headers: { 'Content-Type': 'text/event-stream' },
		})
		const guarded = guardLegacyLaneSseResponse([1], response)
		const text = await readFullResponse(guarded)
		const payloads = parseSsePayloads(text)

		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: { ok: true },
		})
	})

	test('injects error when upstream stream errors mid-flight', async () => {
		const encoder = new TextEncoder()
		const { readable, writable } = new TransformStream<Uint8Array>()
		const writer = writable.getWriter()

		const writeAndAbort = async () => {
			await writer.write(encoder.encode(': keepalive\n\n'))
			await writer.abort(new Error('simulated WS drop'))
		}
		writeAndAbort().catch(() => {})

		const response = new Response(readable, {
			status: 200,
			headers: { 'Content-Type': 'text/event-stream' },
		})
		const guarded = guardLegacyLaneSseResponse([7], response)
		const text = await readFullResponse(guarded)
		const payloads = parseSsePayloads(text)

		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toEqual({
			jsonrpc: '2.0',
			id: 7,
			error: {
				code: -32603,
				message:
					'Internal error: the server connection closed before delivering a response. Please retry.',
			},
		})
	})

	test('cancels upstream reader and skips error injection on client disconnect', async () => {
		const encoder = new TextEncoder()
		let readerCancelled = false

		const upstreamReadable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(': keepalive\n\n'))
			},
			cancel() {
				readerCancelled = true
			},
		})

		const response = new Response(upstreamReadable, {
			status: 200,
			headers: { 'Content-Type': 'text/event-stream' },
		})
		const guarded = guardLegacyLaneSseResponse([42], response)

		const guardedReader = guarded.body!.getReader()
		await guardedReader.read()
		await guardedReader.cancel()

		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(readerCancelled).toBe(true)
	})

	test('preserves original response headers', async () => {
		const response = new Response('', {
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
				'mcp-session-id': 'sess-123',
				'Cache-Control': 'no-cache',
			},
		})
		const guarded = guardLegacyLaneSseResponse([1], response)

		expect(guarded.headers.get('mcp-session-id')).toBe('sess-123')
		expect(guarded.headers.get('Cache-Control')).toBe('no-cache')
		expect(guarded.headers.get('Content-Type')).toBe('text/event-stream')
	})

	test('ignores SSE notifications (no result/error) when tracking IDs', async () => {
		const events = [
			formatSseEvent({
				jsonrpc: '2.0',
				method: 'notifications/progress',
				params: { progressToken: 1, progress: 50 },
			}),
		]
		const response = createSseResponse(events)
		const guarded = guardLegacyLaneSseResponse([1], response)
		const text = await readFullResponse(guarded)
		const payloads = parseSsePayloads(text)

		expect(payloads).toHaveLength(2)
		const injected = payloads[1] as { id: number; error: { code: number } }
		expect(injected.id).toBe(1)
		expect(injected.error.code).toBe(-32603)
	})
})
