import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { expect, test, vi } from 'vitest'
import { planLimits } from '#universal/plans.ts'
import {
	EntitlementLimitError,
	JobIntervalFloorError,
	buildEntitlementLimitMessage,
	buildEntitlementUpgradeHint,
	entitlementLimitErrorCode,
	jobIntervalFloorErrorCode,
} from '#worker/entitlements/errors.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	defaultMcpContentLimitBytes,
	maxMcpContentBlockCount,
	wrapDownstreamMcpToolResult,
} from '#mcp/downstream-mcp-result.ts'
import { formatRawFetchHostNudge } from '#mcp/raw-fetch-host-nudge.ts'
import {
	executeInvokeFlagOffMessage,
	executeInvokeMutualExclusionMessage,
} from '#mcp/execute-invoke.ts'
import type * as AccessControlModule from '#mcp/capabilities/access-control.ts'
import type * as RunRecordsServiceModule from '#worker/run-records/service.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

const heartbeatMock = vi.hoisted(() => ({
	scheduleFleetExecuteLastSuccess: vi.fn(),
}))

vi.mock('#worker/execute-health-heartbeat.ts', () => heartbeatMock)

const mockModule = vi.hoisted(() => ({
	runModuleWithRegistry: vi.fn(),
	createExecutePackageInvokeTools: vi.fn(),
	createPackageRuntimeInvokeTools: vi.fn(),
	createPackageEventTools: vi.fn(),
	getCapabilityRegistryForContext: vi.fn(async () => ({
		capabilityHandlers: {
			codingGuideGet: true,
		},
	})),
	getRunRecordByIdempotencyKey: vi.fn(async () => null),
	claimRunRecord: vi.fn(async () => null),
	finishRunRecord: vi.fn(async () => undefined),
	resolveCallerFeatureFlags: vi.fn(async () => ({
		'execute-invoke': false,
	})),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runModuleWithRegistry: (...args: Array<unknown>) =>
		mockModule.runModuleWithRegistry(...args),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (...args: Array<unknown>) =>
		mockModule.getCapabilityRegistryForContext(...args),
}))

vi.mock(
	'#mcp/capabilities/access-control.ts',
	async (importOriginal: () => Promise<typeof AccessControlModule>) => {
		const actual = await importOriginal()
		return {
			...actual,
			resolveCallerFeatureFlags: (...args: Array<unknown>) =>
				mockModule.resolveCallerFeatureFlags(...args),
		}
	},
)

vi.mock('#worker/package-invocations/service.ts', () => ({
	createExecutePackageInvokeTools: (...args: Array<unknown>) =>
		mockModule.createExecutePackageInvokeTools(...args),
	createPackageRuntimeInvokeTools: (...args: Array<unknown>) =>
		mockModule.createPackageRuntimeInvokeTools(...args),
	createPackageEventTools: (...args: Array<unknown>) =>
		mockModule.createPackageEventTools(...args),
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

const userMeter = createInMemoryUserMeterEnv()

/**
 * Minimal env stub: the daily execute entitlement consumed at the top of
 * the tool handler issues one conditional upsert (allowed when
 * meta.changes > 0). Plan lookup never touches D1 because these caller
 * contexts carry no account email (resolves to `max`).
 */
const stubEnv = {
	...userMeter.env,
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

type ExecuteInput = {
	code?: string
	invoke?: string
	params?: Record<string, unknown>
	responseLimit?: number
	conversationId?: string
	idempotencyKey?: string
}

type ExecuteResponse = {
	content: Array<ContentBlock>
	structuredContent: {
		conversationId: string
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
		errorDetails?: unknown
		entitlement?: {
			code: string
			resource: string
			plan: string
			limit?: number
			current?: number
			upgradeHint: string
			used?: number
			remaining?: number
		}
	}
	isError: boolean
}

type ExecuteHandler = (
	input: ExecuteInput,
	extra?: {
		mcpReq?: {
			_meta?: { progressToken?: string }
			notify?: (notification: unknown) => Promise<void>
		}
	},
) => Promise<ExecuteResponse>

type CallerContext = {
	baseUrl: string
	user: null | {
		userId: string
		email?: string
		displayName?: string
	}
}

async function getExecuteRegistration(
	callerContext: CallerContext = { baseUrl: 'https://example.com', user: null },
	agentExtras: {
		state?: Record<string, unknown>
		setState?: (state: Record<string, unknown>) => void
		waitUntil?: (promise: Promise<unknown>) => void
		invokeEnabled?: boolean
	} = {},
) {
	vi.clearAllMocks()
	mockModule.resolveCallerFeatureFlags.mockResolvedValue({
		'execute-invoke': agentExtras.invokeEnabled === true,
	})
	const registerTool = vi.fn()

	await registerExecuteTool({
		server: { registerTool } as never,
		getEnv: vi.fn(() => stubEnv),
		getCallerContext: vi.fn(() => callerContext),
		requireDomain: vi.fn(),
		getLoopbackExports: vi.fn(),
		...agentExtras,
	} as never)

	expect(registerTool).toHaveBeenCalledTimes(1)
	return registerTool.mock.calls[0] as [
		string,
		{ description: string; inputSchema: Record<string, unknown> },
		ExecuteHandler,
	]
}

async function getExecuteHandler(
	...args: Parameters<typeof getExecuteRegistration>
) {
	const [, , handler] = await getExecuteRegistration(...args)
	return handler
}

function moduleReturns(result: unknown, extra: Record<string, unknown> = {}) {
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result,
		logs: [],
		...extra,
	})
}

function moduleThrows(error: Error, logs: Array<unknown> = []) {
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({ error, logs })
}

const okCode = 'export default async () => ({ ok: true })'
const shouldNotRunCode = 'export default async () => ({ shouldNotRun: true })'
const timing = (durationMs: number) => ({
	startedAt: expect.any(String),
	endedAt: expect.any(String),
	durationMs,
})
const truncationNote = (bytes: number, limit: number) =>
	`Returned value was ${String(bytes)} bytes, exceeding responseLimit ${String(limit)} bytes; output was truncated. Project fields before returning.`

test('execute tool serializes successes and errors, passes package invoke tools, and truncates oversized returns', async () => {
	const handler = await getExecuteHandler()
	const rawContent: Array<ContentBlock> = [
		{
			type: 'image',
			data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
			mimeType: 'image/png',
		},
		{ type: 'text', text: 'Screenshot of https://example.com' },
	]
	mockPerformanceSequence(100, 142)
	moduleReturns(
		{ __mcpContent: rawContent },
		{ logs: [{ level: 'info', message: 'captured screenshot' }] },
	)

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
			capabilityRegistry: { capabilityHandlers: { codingGuideGet: true } },
		}),
	)
	expect(mcpContentResponse.isError).toBe(false)
	expect(mcpContentResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-123' },
		...rawContent,
	])
	expect(mcpContentResponse.structuredContent).toEqual({
		conversationId: 'conv-123',
		timing: timing(42),
		returnedBytes: new TextEncoder().encode(JSON.stringify(rawContent))
			.byteLength,
		result: null,
		logs: [{ level: 'info', message: 'captured screenshot' }],
	})

	const serverTiming = [
		{ name: 'typecheck-total', durationMs: 12 },
		{ name: 'bundle', durationMs: 34 },
		{ name: 'run', durationMs: 56 },
	]
	mockPerformanceSequence(10, 19)
	moduleReturns({ ok: true }, { serverTiming })
	const jsonResponse = await handler({
		code: 'async () => ({ ok: true })',
		conversationId: 'conv-456',
	})
	expect(jsonResponse.isError).toBe(false)
	expect(jsonResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-456' },
		{ type: 'text', text: '{\n  "ok": true\n}' },
	])
	expect(jsonResponse.structuredContent).toEqual({
		conversationId: 'conv-456',
		timing: { ...timing(9), serverTiming },
		returnedBytes: 11,
		result: { ok: true },
		logs: [],
	})

	const packageInvokeTools = { invoke: vi.fn() }
	mockModule.createExecutePackageInvokeTools.mockReturnValueOnce(
		packageInvokeTools,
	)
	const callerContext = {
		baseUrl: 'https://example.com',
		user: { userId: 'user-123', email: 'me@example.com', displayName: 'Me' },
	}
	const authenticatedHandler = await getExecuteHandler(callerContext)
	moduleReturns({ ok: true })
	await authenticatedHandler({ code: okCode, conversationId: 'conv-packages' })
	expect(mockModule.createExecutePackageInvokeTools).toHaveBeenCalledWith({
		env: stubEnv,
		baseUrl: 'https://example.com',
		callerContext: expect.objectContaining(callerContext),
		conversationId: 'conv-packages',
	})
	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining(callerContext),
		okCode,
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
				metadata: { conversationId: 'conv-packages' },
			},
		}),
	)

	mockPerformanceSequence(20, 25)
	moduleReturns('hello world')
	const truncatedStringResponse = await handler({
		code: 'async () => "hello world"',
		responseLimit: 5,
		conversationId: 'conv-truncated-string',
	})
	expect(truncatedStringResponse.isError).toBe(false)
	expect(truncatedStringResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-truncated-string' },
		{
			type: 'text',
			text: `hello\n\n--- TRUNCATED ---\n${truncationNote(11, 5)}`,
		},
	])
	expect(truncatedStringResponse.structuredContent).toEqual({
		conversationId: 'conv-truncated-string',
		timing: timing(5),
		returnedBytes: 11,
		truncated: true,
		note: truncationNote(11, 5),
		result: 'hello',
		logs: [],
	})

	mockPerformanceSequence(30, 40)
	moduleReturns({ rows: [{ id: 'message-1', payload: 'abcdef' }] })
	const truncatedObjectResponse = await handler({
		code: 'async () => ({ rows: [{ id: "message-1", payload: "abcdef" }] })',
		responseLimit: 10,
		conversationId: 'conv-truncated-object',
	})
	expect(truncatedObjectResponse.isError).toBe(false)
	expect(truncatedObjectResponse.content[1]).toEqual({
		type: 'text',
		text: `{\n  "truncated": true,\n  "type": "object"\n}\n\n--- TRUNCATED ---\n${truncationNote(48, 10)}`,
	})
	expect(truncatedObjectResponse.structuredContent).toEqual({
		conversationId: 'conv-truncated-object',
		timing: timing(10),
		returnedBytes: 48,
		truncated: true,
		note: truncationNote(48, 10),
		result: { truncated: true, type: 'object' },
		logs: [],
	})

	mockPerformanceSequence(50, 65)
	moduleThrows(new Error('Boom'), [{ level: 'error', message: 'failed' }])
	const errorResponse = await handler({
		code: 'async () => { throw new Error("Boom") }',
		conversationId: 'conv-error',
	})
	expect(errorResponse.isError).toBe(true)
	expect(errorResponse.structuredContent).toEqual(
		expect.objectContaining({
			conversationId: 'conv-error',
			timing: timing(15),
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
	const conversationLine = (conversationId: string) => ({
		type: 'text',
		text: `conversationId: ${conversationId}`,
	})

	moduleReturns(
		wrapDownstreamMcpToolResult(
			{ content: [webpBlock], structuredContent: { shotId: 's1' } },
			{ kind: 'mcp-server', label: 'vision:screenshot' },
		),
	)
	const passthroughResponse = await handler({
		code: 'async () => downstream',
		conversationId: 'conv-passthrough',
	})
	expect(passthroughResponse.isError).toBe(false)
	expect(passthroughResponse.content).toEqual([
		conversationLine('conv-passthrough'),
		webpBlock,
	])
	expect(passthroughResponse.structuredContent.result).toEqual({
		shotId: 's1',
	})

	const largeBlock = {
		type: 'image' as const,
		data: 'A'.repeat(Math.ceil(110_000 / 4) * 4),
		mimeType: 'image/webp',
	}
	moduleReturns({ __mcpContent: [largeBlock] })
	const largeResponse = await handler({
		code: 'async () => large',
		conversationId: 'conv-large-image',
		responseLimit: 102_400,
	})
	expect(largeResponse.isError).toBe(false)
	expect(largeResponse.content).toEqual([
		conversationLine('conv-large-image'),
		largeBlock,
	])

	moduleReturns({
		__mcpContent: [
			{
				type: 'image',
				data: 'A'.repeat(
					Math.ceil((defaultMcpContentLimitBytes + 50_000) / 4) * 4,
				),
				mimeType: 'image/png',
			},
		],
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
	moduleReturns({ content: [webpBlock], ok: true })
	const arbitraryContentResponse = await handler({
		code: 'async () => ({ content: [...] })',
		conversationId: 'conv-arbitrary-content',
	})
	expect(arbitraryContentResponse.isError).toBe(false)
	expect(arbitraryContentResponse.content).toEqual([
		conversationLine('conv-arbitrary-content'),
		{
			type: 'text',
			text: JSON.stringify({ content: [webpBlock], ok: true }, null, 2),
		},
	])

	// Malformed user-authored __mcpContent becomes an isError result (no throw).
	moduleReturns({
		__mcpContent: [{ type: 'image', data: '!!!', mimeType: 'image/png' }],
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
	moduleReturns({
		__mcpContent: Array.from({ length: maxMcpContentBlockCount + 1 }, () => ({
			type: 'text',
			text: 'x',
		})),
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

test('execute tool nudges repeated raw-fetch hosts once per conversation', async () => {
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
		{ state: agentState, setState },
	)
	const rawFetches =
		(hostname: string, count: number) =>
		async (
			_env: unknown,
			_ctx: unknown,
			_code: string,
			_params: unknown,
			options: { rawFetchHostSink?: { add: (hostname: string) => void } },
		) => {
			for (let i = 0; i < count; i++) {
				options.rawFetchHostSink?.add(hostname)
			}
			return { result: { ok: true }, logs: [] }
		}

	mockModule.runModuleWithRegistry.mockImplementation(
		rawFetches('api.notion.com', 2),
	)
	const warningsFor = async (conversationId: string, code = okCode) =>
		(await handler({ code, conversationId })).structuredContent.warnings
	expect(await warningsFor('conv-nudge')).toBeUndefined()
	const tipped = await warningsFor('conv-nudge')
	expect(tipped).toEqual([
		formatRawFetchHostNudge({ hostname: 'api.notion.com', count: 4 }),
	])
	expect(setState).toHaveBeenCalled()
	expect(await warningsFor('conv-nudge')).toBeUndefined()

	// Integration-auth helper source sharpens the packages-first warning text.
	mockModule.runModuleWithRegistry.mockImplementationOnce(
		rawFetches('gmail.googleapis.com', 3),
	)
	const authHelperTipped = await warningsFor(
		'conv-oauth-nudge',
		`import { createAuthenticatedFetch } from 'kody:runtime'
export default async () => ({ ok: true })`,
	)
	expect(authHelperTipped).toEqual([
		formatRawFetchHostNudge({
			hostname: 'gmail.googleapis.com',
			count: 3,
			usedIntegrationAuthHelpers: true,
		}),
	])
	expect(authHelperTipped?.[0]).not.toBe(tipped?.[0])
})

test('execute tool replays finished keyed runs and reports in-progress without re-executing', async () => {
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
	const handler = await getExecuteHandler({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-keyed-execute',
			email: 'keyed@example.com',
			displayName: 'Keyed',
		},
	})
	const replay = async (
		conversationId: string,
		record: Record<string, unknown> = {},
	) => {
		mockModule.getRunRecordByIdempotencyKey.mockResolvedValueOnce({
			...finishedRun,
			...record,
		} as never)
		const response = await handler({
			code: shouldNotRunCode,
			idempotencyKey: 'spawn-agent-1',
			conversationId,
		})
		expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()
		return response
	}

	const replayed = await replay('conv-replay')
	expect(replayed.isError).toBe(false)
	expect(replayed.structuredContent).toMatchObject({
		runId: 'run-finished-1',
		replayed: true,
		result: { ok: true, agentId: 'agent-9' },
	})

	const inProgress = await replay('conv-running', {
		id: 'run-running-1',
		status: 'running',
		finishedAt: null,
		durationMs: null,
		metadata: {},
	})
	expect(inProgress.isError).toBe(false)
	expect(inProgress.structuredContent).toMatchObject({
		runId: 'run-running-1',
		inProgress: true,
		status: 'running',
	})

	const quotaLimit = planLimits.free.maxExecuteCallsPerDay
	const quotaHint = buildEntitlementUpgradeHint('execute_calls_per_day', 'free')
	const quotaMessage = buildEntitlementLimitMessage({
		code: entitlementLimitErrorCode,
		resource: 'execute_calls_per_day',
		plan: 'free',
		limit: quotaLimit,
		current: quotaLimit,
		upgradeHint: quotaHint,
	})
	const quotaReplayed = await replay('conv-quota-replay', {
		id: 'run-quota-replay-1',
		status: 'error',
		errorName: 'EntitlementLimitError',
		errorMessage: quotaMessage,
		metadata: {},
	})
	expect(quotaReplayed.isError).toBe(true)
	expect(quotaReplayed.structuredContent.error).toBe(quotaMessage)
	expect(quotaReplayed.structuredContent.entitlement).toEqual({
		code: entitlementLimitErrorCode,
		resource: 'execute_calls_per_day',
		plan: 'free',
		limit: quotaLimit,
		current: quotaLimit,
		upgradeHint: quotaHint,
		used: quotaLimit,
		remaining: 0,
	})

	const intervalDenial = new JobIntervalFloorError({
		plan: 'free',
		minIntervalMs: planLimits.free.minJobIntervalMs,
	})
	const intervalReplayed = await replay('conv-interval-replay', {
		id: 'run-interval-replay-1',
		status: 'error',
		errorName: 'JobIntervalFloorError',
		errorMessage: intervalDenial.message,
		metadata: {},
	})
	expect(intervalReplayed.isError).toBe(true)
	expect(intervalReplayed.structuredContent.error).toBe(intervalDenial.message)
	expect(intervalReplayed.structuredContent.entitlement).toEqual({
		code: jobIntervalFloorErrorCode,
		resource: 'scheduled_jobs',
		plan: 'free',
		upgradeHint: intervalDenial.details.upgradeHint,
		minIntervalMs: planLimits.free.minJobIntervalMs,
	})
})

test('execute tool claims a keyed run, passes the handle, and returns runId', async () => {
	const claimedHandle = {
		id: 'run-claimed-1',
		userId: 'user-claim-execute',
		startedAt: '2026-07-28T00:00:00.000Z',
		persistence: 'eager' as const,
		context: { surface: 'execute' as const, idempotencyKey: 'claim-key-1' },
	}
	const handler = await getExecuteHandler({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-claim-execute',
			email: 'claim@example.com',
			displayName: 'Claim',
		},
	})
	mockModule.getRunRecordByIdempotencyKey.mockResolvedValueOnce(null)
	mockModule.claimRunRecord.mockResolvedValueOnce({
		claimed: true,
		handle: claimedHandle,
	} as never)
	moduleReturns({ spawned: true }, { runId: 'run-claimed-1' })
	const code = 'export default async () => ({ spawned: true })'
	const response = await handler({
		code,
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
		code,
		undefined,
		expect.objectContaining({
			runRecordHandle: claimedHandle,
			runRecord: expect.objectContaining({ idempotencyKey: 'claim-key-1' }),
		}),
	)
	expect(response.structuredContent).toMatchObject({
		runId: 'run-claimed-1',
		result: { spawned: true },
	})
})

test('execute tool threads a progress reporter when the client sends progressToken', async () => {
	const handler = await getExecuteHandler()
	moduleReturns({ ok: true })
	const notify = vi.fn().mockResolvedValue(undefined)
	await handler(
		{ code: okCode },
		{ mcpReq: { _meta: { progressToken: 'progress-1' }, notify } },
	)
	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.anything(),
		okCode,
		undefined,
		expect.objectContaining({ reportProgress: expect.any(Function) }),
	)
	const options = mockModule.runModuleWithRegistry.mock.calls.at(-1)?.[4] as {
		reportProgress?: (update: {
			progress: number
			message?: string
		}) => Promise<void>
	}
	await options.reportProgress?.({ progress: 1, message: 'bundle time' })
	expect(notify).toHaveBeenCalledWith({
		method: 'notifications/progress',
		params: {
			progressToken: 'progress-1',
			progress: 1,
			message: 'bundle time',
		},
	})
})

test('execute tool attaches entitlement metadata on denials and quota, not on success, and heartbeats only on success', async () => {
	const handler = await getExecuteHandler()
	mockPerformanceSequence(1, 2)
	moduleReturns({ ok: true })
	const success = await handler({
		code: okCode,
		conversationId: 'conv-entitlement-success',
	})
	expect(success.isError).toBe(false)
	expect(success.structuredContent).toEqual({
		conversationId: 'conv-entitlement-success',
		timing: timing(1),
		returnedBytes: expect.any(Number),
		result: { ok: true },
		logs: [],
	})
	expect(success.structuredContent).not.toHaveProperty('entitlement')
	expect(heartbeatMock.scheduleFleetExecuteLastSuccess).toHaveBeenCalledTimes(1)

	heartbeatMock.scheduleFleetExecuteLastSuccess.mockClear()
	const stockLimit = planLimits.free.maxSavedPackages
	const stockHint = buildEntitlementUpgradeHint('saved_packages', 'free')
	const stockDenial = new EntitlementLimitError({
		resource: 'saved_packages',
		plan: 'free',
		limit: stockLimit,
		current: stockLimit,
		upgradeHint: stockHint,
	})
	moduleThrows(stockDenial)
	const denied = await handler({
		code: 'export default async () => { throw stockDenial }',
		conversationId: 'conv-entitlement-stock',
	})
	expect(denied.isError).toBe(true)
	expect(denied.structuredContent.error).toBe(stockDenial.message)
	expect(denied.structuredContent.entitlement).toEqual({
		code: entitlementLimitErrorCode,
		resource: 'saved_packages',
		plan: 'free',
		limit: stockLimit,
		current: stockLimit,
		upgradeHint: stockHint,
	})
	expect(denied.structuredContent.entitlement).not.toHaveProperty('used')
	expect(denied.structuredContent.entitlement).not.toHaveProperty('remaining')

	moduleThrows(new Error('caller boom'))
	const failure = await handler({
		code: 'export default async () => { throw new Error("caller boom") }',
		conversationId: 'conv-heartbeat-error',
	})
	expect(failure.isError).toBe(true)
	expect(failure.structuredContent).not.toHaveProperty('entitlement')
	expect(heartbeatMock.scheduleFleetExecuteLastSuccess).not.toHaveBeenCalled()

	const quotaEmail = 'quota-metadata@example.com'
	const quotaUserId = await createStableUserIdFromEmail(quotaEmail)
	const quotaLimit = planLimits.free.maxExecuteCallsPerDay
	const quotaHint = buildEntitlementUpgradeHint('execute_calls_per_day', 'free')
	await userMeter.seed({
		userId: quotaUserId,
		resource: 'execute_calls_per_day',
		day: utcDayKey(new Date()),
		count: quotaLimit,
	})
	const quotaHandler = await getExecuteHandler({
		baseUrl: 'https://example.com',
		user: { userId: quotaUserId, email: quotaEmail },
	})
	const quotaDenied = await quotaHandler({
		code: shouldNotRunCode,
		conversationId: 'conv-entitlement-quota',
	})
	expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()
	expect(quotaDenied.isError).toBe(true)
	const quotaEntitlement = {
		code: entitlementLimitErrorCode,
		resource: 'execute_calls_per_day',
		plan: 'free',
		limit: quotaLimit,
		current: quotaLimit,
		upgradeHint: quotaHint,
	} as const
	expect(quotaDenied.structuredContent.error).toBe(
		buildEntitlementLimitMessage(quotaEntitlement),
	)
	expect(quotaDenied.structuredContent.entitlement).toEqual({
		...quotaEntitlement,
		used: quotaLimit,
		remaining: 0,
	})
})

test('execute invoke is omitted when the flag is off and mints the handwritten passthrough when on', async () => {
	const [offName, offConfig, offHandler] = await getExecuteRegistration()
	expect(offName).toBe('execute')
	expect(offConfig.inputSchema).not.toHaveProperty('invoke')

	const rejected = await offHandler({
		invoke: 'kody:@acme/github/listRepos',
		conversationId: 'conv-invoke-off',
	})
	expect(rejected.isError).toBe(true)
	expect(rejected.structuredContent.error).toBe(executeInvokeFlagOffMessage)
	expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()

	const [, onConfig, onHandler] = await getExecuteRegistration(
		{ baseUrl: 'https://example.com', user: { userId: 'user-1' } },
		{ invokeEnabled: true },
	)
	expect(onConfig.inputSchema).toHaveProperty('invoke')

	moduleReturns({ ok: true })
	const invoked = await onHandler({
		invoke: '@acme/github#listRepos',
		params: { limit: 5 },
		conversationId: 'conv-invoke-on',
	})
	expect(invoked.isError).toBe(false)
	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledWith(
		expect.anything(),
		expect.anything(),
		`import action from "kody:@acme/github/listRepos"

export default async function main(params) {
	return await action(params)
}`,
		{ limit: 5 },
		expect.anything(),
	)

	const both = await onHandler({
		code: 'export default async function main() { return 1 }',
		invoke: 'kody:@acme/github/listRepos',
		conversationId: 'conv-invoke-both',
	})
	expect(both.isError).toBe(true)
	expect(both.structuredContent.error).toBe(executeInvokeMutualExclusionMessage)

	mockModule.resolveCallerFeatureFlags.mockResolvedValue({
		'execute-invoke': false,
	})
	const killed = await onHandler({
		invoke: 'kody:@acme/github/listRepos',
		conversationId: 'conv-invoke-killed',
	})
	expect(killed.isError).toBe(true)
	expect(killed.structuredContent.error).toBe(executeInvokeFlagOffMessage)
	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledTimes(1)
})
