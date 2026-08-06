/**
 * Advertising an MCP `outputSchema` makes the SDK validate every successful
 * result's `structuredContent` against it server-side (v1 `McpServer` runs
 * `safeParseAsync` on the zod object; v2 validates the converted JSON
 * schema). A schema that rejects a real response would turn working calls
 * into protocol errors, so these tests run representative structured
 * responses from every return path through the advertised schemas exactly
 * the way the SDK does.
 */

import { expect, test } from 'vitest'
import { z } from 'zod'
import { searchToolOutputSchema } from './search-tool-definition.ts'
import { executeToolOutputSchema } from './execute.ts'

const timing = {
	startedAt: '2026-08-05T00:00:00.000Z',
	endedAt: '2026-08-05T00:00:01.000Z',
	durationMs: 1000,
}

const searchSchema = z.object(searchToolOutputSchema)
const executeSchema = z.object(executeToolOutputSchema)

test('search structured content passes advertised schema for all return paths', async () => {
	const payloads = [
		{
			conversationId: 'c1',
			timing,
			result: {
				offline: false,
				warnings: [],
				telemetry: { topResultTypes: ['capability'] },
				phaseTimings: { formattingMs: 2 },
				matches: [{ type: 'capability', name: 'email_send' }],
			},
		},
		{
			conversationId: 'c1',
			timing,
			result: { entityRef: 'x:capability' },
		},
		{
			conversationId: 'c1',
			timing,
			result: [{ entityRef: 'a:capability', error: 'not found' }],
			error: 'All entity lookups failed.',
		},
		{ conversationId: 'c1', timing, error: 'Provide "query".' },
	]
	for (const payload of payloads) {
		const parsed = await searchSchema.safeParseAsync(payload)
		expect(parsed.success).toBe(true)
	}
})

test('execute structured content passes advertised schema for all return paths', async () => {
	const payloads = [
		{
			conversationId: 'c1',
			timing: { ...timing, serverTiming: [{ name: 'registry', ms: 5 }] },
			storage: { id: 'bucket-1' },
			returnedBytes: 42,
			result: { anything: ['goes', 1, null] },
			logs: ['log line', { level: 'warn' }],
			warnings: ['Consider integration auth helpers for api.example.com.'],
			memories: { surfaced: [], suppressedCount: 0 },
		},
		{
			conversationId: 'c1',
			timing,
			returnedBytes: 100000,
			truncated: true,
			note: 'Result truncated to fit responseLimit.',
			result: 'partial…',
			logs: [],
		},
		{
			conversationId: 'c1',
			timing,
			returnedBytes: 0,
			error: 'ReferenceError: foo is not defined',
			errorDetails: { phase: 'sandbox' },
			logs: [],
		},
		{
			conversationId: 'c1',
			timing,
			runId: 'run-1',
			replayed: true,
			returnedBytes: 0,
			result: { ok: true },
			logs: [],
		},
		{
			conversationId: 'c1',
			timing,
			runId: 'run-1',
			inProgress: true,
			status: 'running',
		},
	]
	for (const payload of payloads) {
		const parsed = await executeSchema.safeParseAsync(payload)
		expect(parsed.success).toBe(true)
	}
})

test('schemas convert to JSON Schema without throwing', () => {
	// The SDK advertises the zod schemas as JSON Schema on tools/list; a
	// conversion failure would drop the advertisement or break listing.
	expect(() => z.toJSONSchema(searchSchema, { io: 'output' })).not.toThrow()
	expect(() => z.toJSONSchema(executeSchema, { io: 'output' })).not.toThrow()
})
