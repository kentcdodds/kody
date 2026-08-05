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

test.each([
	[
		'ranked list result',
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
	],
	[
		'entity detail result',
		{ conversationId: 'c1', timing, result: { entityRef: 'x:capability' } },
	],
	[
		'entity batch with partial failures',
		{
			conversationId: 'c1',
			timing,
			result: [{ entityRef: 'a:capability', error: 'not found' }],
			error: 'All entity lookups failed.',
		},
	],
	[
		'validation error',
		{ conversationId: 'c1', timing, error: 'Provide "query".' },
	],
])(
	'search structured content passes advertised schema: %s',
	async (_, payload) => {
		const parsed = await searchSchema.safeParseAsync(payload)
		expect(parsed.success).toBe(true)
	},
)

test.each([
	[
		'success with storage and warnings',
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
	],
	[
		'truncated result',
		{
			conversationId: 'c1',
			timing,
			returnedBytes: 100000,
			truncated: true,
			note: 'Result truncated to fit responseLimit.',
			result: 'partial…',
			logs: [],
		},
	],
	[
		'sandbox error',
		{
			conversationId: 'c1',
			timing,
			returnedBytes: 0,
			error: 'ReferenceError: foo is not defined',
			errorDetails: { phase: 'sandbox' },
			logs: [],
		},
	],
	[
		'keyed replay',
		{
			conversationId: 'c1',
			timing,
			runId: 'run-1',
			replayed: true,
			returnedBytes: 0,
			result: { ok: true },
			logs: [],
		},
	],
	[
		'keyed in-progress lookup',
		{
			conversationId: 'c1',
			timing,
			runId: 'run-1',
			inProgress: true,
			status: 'running',
		},
	],
])(
	'execute structured content passes advertised schema: %s',
	async (_, payload) => {
		const parsed = await executeSchema.safeParseAsync(payload)
		expect(parsed.success).toBe(true)
	},
)

test('schemas convert to JSON Schema without throwing', () => {
	// The SDK advertises the zod schemas as JSON Schema on tools/list; a
	// conversion failure would drop the advertisement or break listing.
	expect(() => z.toJSONSchema(searchSchema, { io: 'output' })).not.toThrow()
	expect(() => z.toJSONSchema(executeSchema, { io: 'output' })).not.toThrow()
})
