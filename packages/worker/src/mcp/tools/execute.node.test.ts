import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { expect, test, vi } from 'vitest'
import {
	defaultMcpContentLimitBytes,
	maxMcpContentBlockCount,
	wrapDownstreamMcpToolResult,
} from '#mcp/downstream-mcp-result.ts'
import { formatRawFetchHostNudge } from '#mcp/raw-fetch-host-nudge.ts'
import type * as RunRecordsServiceModule from '#worker/run-records/service.ts'

const mockModule = vi.hoisted(() => ({
	runModuleWithRegistry: vi.fn(),
	createExecutePackageInvokeTools: vi.fn(),
	getCapabilityRegistryForContext: vi.fn(async () => ({
		capabilityHandlers: {
			coding_guide_get: true,
		},
	})),
	listOpenApiBindings: vi.fn(async () => []),
	getRunRecordByIdempotencyKey: vi.fn(async () => null),
	claimRunRecord: vi.fn(async () => null),
	finishRunRecord: vi.fn(async () => undefined),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runModuleWithRegistry: (...args: Array<unknown>) =>
		mockModule.runModuleWithRegistry(...args),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (...args: Array<unknown>) =>
		mockModule.getCapabilityRegistryForContext(...args),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	createExecutePackageInvokeTools: (...args: Array<unknown>) =>
		mockModule.createExecutePackageInvokeTools(...args),
}))

vi.mock('#worker/openapi/binding-service.ts', () => ({
	listOpenApiBindings: (...args: Array<unknown>) =>
		mockModule.listOpenApiBindings(...args),
}))

vi.mock('#worker/run-records/service.ts', async () => {
	const actual = await vi.importActual<typeof RunRecordsServiceModule>(
		'#worker/run-records/service.ts',
	)
	return {
		...actual,
		getRunRecordByIdempotencyKey: (...args: Array<unknown>) =>
			mockModule.getRunRecordByIdempotencyKey(...args),
		claimRunRecord: (...args: Array<unknown>) =>
			mockModule.claimRunRecord(...args),
		finishRunRecord: (...args: Array<unknown>) =>
			mockModule.finishRunRecord(...args),
	}
})

const { registerExecuteTool } = await import('./execute.ts')

/**
 * Minimal env stub: the daily execute entitlement consumed at the top of
 * the tool handler issues one conditional upsert (allowed when
 * meta.changes > 0). Plan lookup never touches D1 because these caller
 * contexts carry no account email (resolves to `max`).
 */
const stubEnv = {
	APP_DB: {
		prepare() {
			return {
				bind() {
					return {
						async run() {
							return { meta: { changes: 1 } }
						},
						async first() {
							return null
						},
					}
				},
			}
		},
	},
}

const mockPerformanceNow = vi.spyOn(performance, 'now')

function mockPerformanceSequence(...values: Array<number>) {
	let index = 0
	mockPerformanceNow.mockImplementation(() => {
		const value = values[Math.min(index, values.length - 1)] ?? 0
		index += 1
		return value
	})
}

async function getExecuteRegistration(
	callerContext: {
		baseUrl: string
		user: null | {
			userId: string
			email?: string
			displayName?: string
		}
	} = {
		baseUrl: 'https://example.com',
		user: null,
	},
	agentExtras: {
		state?: Record<string, unknown>
		setState?: (state: Record<string, unknown>) => void
	} = {},
) {
	vi.clearAllMocks()
	const registerTool = vi.fn()

	await registerExecuteTool({
		server: {
			registerTool,
		} as never,
		getEnv: vi.fn(() => stubEnv),
		getCallerContext: vi.fn(() => callerContext),
		requireDomain: vi.fn(),
		getLoopbackExports: vi.fn(),
		...agentExtras,
	} as never)

	expect(registerTool).toHaveBeenCalledTimes(1)
	return registerTool.mock.calls[0] as [
		string,
		{ description: string },
		(input: {
			code: string
			storageId?: string
			writable?: boolean
			responseLimit?: number
			conversationId?: string
		}) => Promise<{
			content: Array<ContentBlock>
			structuredContent: {
				conversationId: string
				storage?: { id: string }
				returnedBytes: number
				truncated?: boolean
				note?: string
				warnings?: Array<string>
				timing: {
					startedAt: string
					endedAt: string
					durationMs: number
				}
				result: unknown
				logs: Array<unknown>
				error?: string
			}
			isError: boolean
		}>,
	]
}

async function getExecuteHandler(
	callerContext?: Parameters<typeof getExecuteRegistration>[0],
	agentExtras?: Parameters<typeof getExecuteRegistration>[1],
) {
	const [, , handler] = await getExecuteRegistration(callerContext, agentExtras)
	return handler as (input: {
		code: string
		storageId?: string
		writable?: boolean
		responseLimit?: number
		conversationId?: string
		idempotencyKey?: string
	}) => Promise<{
		content: Array<ContentBlock>
		structuredContent: {
			conversationId: string
			storage?: { id: string }
			runId?: string
			replayed?: boolean
			inProgress?: boolean
			status?: string
			returnedBytes: number
			truncated?: boolean
			note?: string
			warnings?: Array<string>
			timing: {
				startedAt: string
				endedAt: string
				durationMs: number
			}
			result: unknown
			logs: Array<unknown>
			error?: string
		}
		isError: boolean
	}>
}

test('execute tool serializes successes and errors, binds storage, passes package invoke tools, and truncates oversized returns', async () => {
	const handler = await getExecuteHandler()
	const rawContent: Array<ContentBlock> = [
		{
			type: 'image',
			data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
			mimeType: 'image/png',
		},
		{
			type: 'text',
			text: 'Screenshot of https://example.com',
		},
	]
	mockPerformanceSequence(100, 142)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			__mcpContent: rawContent,
		},
		logs: [{ level: 'info', message: 'captured screenshot' }],
	})
	const returnedBytes = new TextEncoder().encode(
		JSON.stringify(rawContent),
	).byteLength

	const mcpContentResponse = await handler({
		code: 'async () => ({ __mcpContent: [] })',
		conversationId: 'conv-123',
	})

	expect(mockModule.getCapabilityRegistryForContext).toHaveBeenCalledTimes(1)
	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.anything(),
		'async () => ({ __mcpContent: [] })',
		undefined,
		expect.objectContaining({
			capabilityRegistry: {
				capabilityHandlers: {
					coding_guide_get: true,
				},
			},
		}),
	)
	expect(mcpContentResponse.isError).toBe(false)
	expect(mcpContentResponse.content).toEqual([
		{
			type: 'text',
			text: 'conversationId: conv-123',
		},
		...rawContent,
	])
	expect(mcpContentResponse.structuredContent).toEqual({
		conversationId: 'conv-123',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 42,
		},
		returnedBytes,
		result: null,
		logs: [{ level: 'info', message: 'captured screenshot' }],
	})

	mockPerformanceSequence(10, 19)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
		serverTiming: [
			{ name: 'typecheck-total', durationMs: 12 },
			{ name: 'bundle', durationMs: 34 },
			{ name: 'run', durationMs: 56 },
		],
	})

	const jsonResponse = await handler({
		code: 'async () => ({ ok: true })',
		conversationId: 'conv-456',
	})

	expect(jsonResponse.isError).toBe(false)
	expect(jsonResponse.content).toEqual([
		{
			type: 'text',
			text: 'conversationId: conv-456',
		},
		{
			type: 'text',
			text: '{\n  "ok": true\n}',
		},
	])
	expect(jsonResponse.structuredContent).toEqual({
		conversationId: 'conv-456',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 9,
			serverTiming: [
				{ name: 'typecheck-total', durationMs: 12 },
				{ name: 'bundle', durationMs: 34 },
				{ name: 'run', durationMs: 56 },
			],
		},
		returnedBytes: 11,
		result: { ok: true },
		logs: [],
	})

	mockPerformanceSequence(1, 8)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})

	const storageResponse = await handler({
		code: 'async () => ({ ok: true })',
		storageId: 'job:lights-off',
		writable: true,
		conversationId: 'conv-789',
	})

	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining({
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: null,
				storageId: 'job:lights-off',
			},
		}),
		'async () => ({ ok: true })',
		undefined,
		expect.objectContaining({
			storageTools: {
				userId: '',
				storageId: 'job:lights-off',
				writable: true,
			},
		}),
	)
	expect(storageResponse.structuredContent).toEqual({
		conversationId: 'conv-789',
		storage: { id: 'job:lights-off' },
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 7,
		},
		returnedBytes: 11,
		result: { ok: true },
		logs: [],
	})

	const packageInvokeTools = {
		invoke: vi.fn(),
	}
	mockModule.createExecutePackageInvokeTools.mockReturnValueOnce(
		packageInvokeTools,
	)
	const callerContext = {
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'Me',
		},
	}
	const authenticatedHandler = await getExecuteHandler(callerContext)
	mockPerformanceSequence(9, 12)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})

	await authenticatedHandler({
		code: 'export default async () => ({ ok: true })',
		conversationId: 'conv-packages',
	})

	expect(mockModule.createExecutePackageInvokeTools).toHaveBeenCalledWith({
		env: stubEnv,
		baseUrl: 'https://example.com',
		callerContext: expect.objectContaining(callerContext),
		conversationId: 'conv-packages',
	})
	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining(callerContext),
		'export default async () => ({ ok: true })',
		undefined,
		expect.objectContaining({
			packageInvokeTools,
			conversationId: 'conv-packages',
			runRecordHandle: null,
			runRecord: {
				surface: 'execute',
				name: null,
				storageId: null,
				idempotencyKey: null,
				metadata: {
					conversationId: 'conv-packages',
				},
			},
		}),
	)

	mockPerformanceSequence(20, 25)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: 'hello world',
		logs: [],
	})

	const truncatedStringResponse = await handler({
		code: 'async () => "hello world"',
		responseLimit: 5,
		conversationId: 'conv-truncated-string',
	})

	expect(truncatedStringResponse.isError).toBe(false)
	expect(truncatedStringResponse.content).toEqual([
		{
			type: 'text',
			text: 'conversationId: conv-truncated-string',
		},
		{
			type: 'text',
			text: 'hello\n\n--- TRUNCATED ---\nReturned value was 11 bytes, exceeding responseLimit 5 bytes; output was truncated. Project fields before returning.',
		},
	])
	expect(truncatedStringResponse.structuredContent).toEqual({
		conversationId: 'conv-truncated-string',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 5,
		},
		returnedBytes: 11,
		truncated: true,
		note: 'Returned value was 11 bytes, exceeding responseLimit 5 bytes; output was truncated. Project fields before returning.',
		result: 'hello',
		logs: [],
	})

	mockPerformanceSequence(30, 40)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: { rows: [{ id: 'message-1', payload: 'abcdef' }] },
		logs: [],
	})

	const truncatedObjectResponse = await handler({
		code: 'async () => ({ rows: [{ id: "message-1", payload: "abcdef" }] })',
		responseLimit: 10,
		conversationId: 'conv-truncated-object',
	})

	expect(truncatedObjectResponse.isError).toBe(false)
	expect(truncatedObjectResponse.structuredContent).toEqual({
		conversationId: 'conv-truncated-object',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 10,
		},
		returnedBytes: 48,
		truncated: true,
		note: 'Returned value was 48 bytes, exceeding responseLimit 10 bytes; output was truncated. Project fields before returning.',
		result: {
			truncated: true,
			type: 'object',
		},
		logs: [],
	})

	mockPerformanceSequence(50, 65)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		error: new Error('Boom'),
		logs: [{ level: 'error', message: 'failed' }],
	})

	const errorResponse = await handler({
		code: 'async () => { throw new Error("Boom") }',
		conversationId: 'conv-error',
	})

	expect(errorResponse.isError).toBe(true)
	expect(errorResponse.structuredContent).toEqual(
		expect.objectContaining({
			conversationId: 'conv-error',
			timing: {
				startedAt: expect.any(String),
				endedAt: expect.any(String),
				durationMs: 15,
			},
			error: 'Boom',
			returnedBytes: 0,
			logs: [{ level: 'error', message: 'failed' }],
		}),
	)
})

test('execute passes through downstream MCP image content with structured data and rejects oversize content explicitly', async () => {
	const handler = await getExecuteHandler()
	const webpBlock = {
		type: 'image' as const,
		data: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
		mimeType: 'image/webp',
	}

	mockPerformanceSequence(1, 2)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: wrapDownstreamMcpToolResult(
			{
				content: [webpBlock],
				structuredContent: { shotId: 's1' },
			},
			{ kind: 'mcp-server', label: 'vision:screenshot' },
		),
		logs: [],
	})

	const passthroughResponse = await handler({
		code: 'async () => downstream',
		conversationId: 'conv-passthrough',
	})

	expect(passthroughResponse.isError).toBe(false)
	expect(passthroughResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-passthrough' },
		webpBlock,
	])
	expect(passthroughResponse.structuredContent.result).toEqual({
		shotId: 's1',
	})

	const largeData = 'A'.repeat(Math.ceil(110_000 / 4) * 4)
	const largeBlock = {
		type: 'image' as const,
		data: largeData,
		mimeType: 'image/webp',
	}
	mockPerformanceSequence(3, 4)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			__mcpContent: [largeBlock],
		},
		logs: [],
	})

	const largeResponse = await handler({
		code: 'async () => large',
		conversationId: 'conv-large-image',
		responseLimit: 102_400,
	})

	expect(largeResponse.isError).toBe(false)
	expect(largeResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-large-image' },
		largeBlock,
	])

	const tooLargeData = 'A'.repeat(
		Math.ceil((defaultMcpContentLimitBytes + 50_000) / 4) * 4,
	)
	mockPerformanceSequence(5, 6)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			__mcpContent: [
				{
					type: 'image',
					data: tooLargeData,
					mimeType: 'image/png',
				},
			],
		},
		logs: [],
	})

	const oversizeResponse = await handler({
		code: 'async () => oversize',
		conversationId: 'conv-oversize',
	})

	expect(oversizeResponse.isError).toBe(true)
	expect(oversizeResponse.structuredContent.error).toContain(
		'exceeding content limit',
	)
	expect(oversizeResponse.content[1]).toMatchObject({
		type: 'text',
		text: expect.stringContaining('exceeding content limit'),
	})

	// Ordinary application objects with a `content` array stay JSON text.
	mockPerformanceSequence(7, 8)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			content: [webpBlock],
			ok: true,
		},
		logs: [],
	})
	const arbitraryContentResponse = await handler({
		code: 'async () => ({ content: [...] })',
		conversationId: 'conv-arbitrary-content',
	})
	expect(arbitraryContentResponse.isError).toBe(false)
	expect(arbitraryContentResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-arbitrary-content' },
		{
			type: 'text',
			text: JSON.stringify({ content: [webpBlock], ok: true }, null, 2),
		},
	])
	expect(arbitraryContentResponse.content.some((b) => b.type === 'image')).toBe(
		false,
	)

	// Malformed user-authored __mcpContent becomes an isError result (no throw).
	mockPerformanceSequence(9, 10)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			__mcpContent: [{ type: 'image', data: '!!!', mimeType: 'image/png' }],
		},
		logs: [],
	})
	const malformedResponse = await handler({
		code: 'async () => bad',
		conversationId: 'conv-malformed',
	})
	expect(malformedResponse.isError).toBe(true)
	expect(malformedResponse.structuredContent.error).toMatch(
		/default export \(__mcpContent\)[\s\S]*malformed MCP content/,
	)
	expect(malformedResponse.content.some((b) => b.type === 'image')).toBe(false)

	// Too many content blocks fail before expensive validation work.
	mockPerformanceSequence(11, 12)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			__mcpContent: Array.from({ length: maxMcpContentBlockCount + 1 }, () => ({
				type: 'text',
				text: 'x',
			})),
		},
		logs: [],
	})
	const tooManyBlocksResponse = await handler({
		code: 'async () => many',
		conversationId: 'conv-too-many-blocks',
	})
	expect(tooManyBlocksResponse.isError).toBe(true)
	expect(tooManyBlocksResponse.structuredContent.error).toContain(
		'too many MCP content blocks',
	)
})

test('execute tool nudges repeated raw-fetch hosts once per conversation and skips OpenAPI-covered hosts', async () => {
	const agentState: Record<string, unknown> = {}
	const setState = vi.fn((next: Record<string, unknown>) => {
		for (const key of Object.keys(agentState)) {
			delete agentState[key]
		}
		Object.assign(agentState, next)
	})
	const handler = await getExecuteHandler(
		{
			baseUrl: 'https://example.com',
			user: { userId: 'user-1', email: 'user@example.com' },
		},
		{
			state: agentState,
			setState,
		},
	)

	mockModule.runModuleWithRegistry.mockImplementation(
		async (
			_env,
			_ctx,
			_code,
			_params,
			options: { rawFetchHostSink?: { add: (hostname: string) => void } },
		) => {
			options.rawFetchHostSink?.add('api.notion.com')
			options.rawFetchHostSink?.add('api.notion.com')
			return { result: { ok: true }, logs: [] }
		},
	)
	mockPerformanceSequence(1, 2)
	const below = await handler({
		code: 'export default async () => ({ ok: true })',
		conversationId: 'conv-nudge',
	})
	expect(below.structuredContent.warnings).toBeUndefined()

	mockPerformanceSequence(3, 4)
	const tipped = await handler({
		code: 'export default async () => ({ ok: true })',
		conversationId: 'conv-nudge',
	})
	expect(tipped.structuredContent.warnings).toEqual([
		formatRawFetchHostNudge({
			hostname: 'api.notion.com',
			count: 4,
		}),
	])
	expect(setState).toHaveBeenCalled()
	expect(mockModule.listOpenApiBindings).toHaveBeenCalled()

	mockPerformanceSequence(5, 6)
	const again = await handler({
		code: 'export default async () => ({ ok: true })',
		conversationId: 'conv-nudge',
	})
	expect(again.structuredContent.warnings).toBeUndefined()

	mockModule.listOpenApiBindings.mockResolvedValueOnce([
		{
			name: 'kit',
			apiBaseUrl: 'https://api.kit.com/v4',
		},
	])
	mockModule.runModuleWithRegistry.mockImplementationOnce(
		async (
			_env,
			_ctx,
			_code,
			_params,
			options: { rawFetchHostSink?: { add: (hostname: string) => void } },
		) => {
			options.rawFetchHostSink?.add('api.kit.com')
			options.rawFetchHostSink?.add('api.kit.com')
			options.rawFetchHostSink?.add('api.kit.com')
			return { result: { ok: true }, logs: [] }
		},
	)
	mockPerformanceSequence(7, 8)
	const covered = await handler({
		code: 'export default async () => ({ ok: true })',
		conversationId: 'conv-covered',
	})
	expect(covered.structuredContent.warnings).toBeUndefined()

	// Integration-auth helper source sharpens the packages-first warning text.
	mockModule.runModuleWithRegistry.mockImplementationOnce(
		async (
			_env,
			_ctx,
			_code,
			_params,
			options: { rawFetchHostSink?: { add: (hostname: string) => void } },
		) => {
			options.rawFetchHostSink?.add('gmail.googleapis.com')
			options.rawFetchHostSink?.add('gmail.googleapis.com')
			options.rawFetchHostSink?.add('gmail.googleapis.com')
			return { result: { ok: true }, logs: [] }
		},
	)
	mockPerformanceSequence(9, 10)
	const authHelperTipped = await handler({
		code: `import { createAuthenticatedFetch } from 'kody:runtime'
export default async () => ({ ok: true })`,
		conversationId: 'conv-oauth-nudge',
	})
	expect(authHelperTipped.structuredContent.warnings).toEqual([
		formatRawFetchHostNudge({
			hostname: 'gmail.googleapis.com',
			count: 3,
			usedIntegrationAuthHelpers: true,
		}),
	])
	expect(authHelperTipped.structuredContent.warnings?.[0]).not.toBe(
		tipped.structuredContent.warnings?.[0],
	)
})

test('execute tool replays finished keyed runs and reports in-progress without re-executing', async () => {
	const authenticatedCaller = {
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-keyed-execute',
			email: 'keyed@example.com',
			displayName: 'Keyed',
		},
	}
	const finishedRun = {
		id: 'run-finished-1',
		surface: 'execute' as const,
		status: 'success' as const,
		name: null,
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: null,
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: 'spawn-agent-1',
		parentRunId: null,
		startedAt: '2026-07-28T00:00:00.000Z',
		finishedAt: '2026-07-28T00:00:01.000Z',
		durationMs: 1000,
		errorName: null,
		errorMessage: null,
		metadata: { result: { ok: true, agentId: 'agent-9' } },
		logCount: 0,
	}
	const handler = await getExecuteHandler(authenticatedCaller)
	mockModule.getRunRecordByIdempotencyKey.mockResolvedValueOnce(finishedRun)
	mockPerformanceSequence(1, 2)
	const replayed = await handler({
		code: 'export default async () => ({ shouldNotRun: true })',
		idempotencyKey: 'spawn-agent-1',
		conversationId: 'conv-replay',
	})
	expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()
	expect(replayed.isError).toBe(false)
	expect(replayed.structuredContent).toMatchObject({
		runId: 'run-finished-1',
		replayed: true,
		result: { ok: true, agentId: 'agent-9' },
	})

	mockModule.getRunRecordByIdempotencyKey.mockResolvedValueOnce({
		...finishedRun,
		id: 'run-running-1',
		status: 'running',
		finishedAt: null,
		durationMs: null,
		metadata: {},
	})
	mockPerformanceSequence(3, 4)
	const inProgress = await handler({
		code: 'export default async () => ({ shouldNotRun: true })',
		idempotencyKey: 'spawn-agent-1',
		conversationId: 'conv-running',
	})
	expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()
	expect(inProgress.isError).toBe(false)
	expect(inProgress.structuredContent).toMatchObject({
		runId: 'run-running-1',
		inProgress: true,
		status: 'running',
	})
})

test('execute tool claims a keyed run, passes the handle, and returns runId', async () => {
	const authenticatedCaller = {
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-claim-execute',
			email: 'claim@example.com',
			displayName: 'Claim',
		},
	}
	const claimedHandle = {
		id: 'run-claimed-1',
		userId: 'user-claim-execute',
		startedAt: '2026-07-28T00:00:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'execute' as const,
			idempotencyKey: 'claim-key-1',
		},
	}
	const handler = await getExecuteHandler(authenticatedCaller)
	mockModule.getRunRecordByIdempotencyKey.mockResolvedValueOnce(null)
	mockModule.claimRunRecord.mockResolvedValueOnce({
		claimed: true,
		handle: claimedHandle,
	})
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: { spawned: true },
		logs: [],
		runId: 'run-claimed-1',
	})
	mockPerformanceSequence(5, 6)
	const response = await handler({
		code: 'export default async () => ({ spawned: true })',
		idempotencyKey: 'claim-key-1',
		conversationId: 'conv-claim',
	})
	expect(mockModule.claimRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-claim-execute',
			context: expect.objectContaining({
				surface: 'execute',
				idempotencyKey: 'claim-key-1',
			}),
		}),
	)
	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledWith(
		expect.anything(),
		expect.anything(),
		'export default async () => ({ spawned: true })',
		undefined,
		expect.objectContaining({
			runRecordHandle: claimedHandle,
			runRecord: expect.objectContaining({
				idempotencyKey: 'claim-key-1',
			}),
		}),
	)
	expect(response.structuredContent).toMatchObject({
		runId: 'run-claimed-1',
		result: { spawned: true },
	})
})
