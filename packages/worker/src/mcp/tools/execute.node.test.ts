import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	runModuleWithRegistry: vi.fn(),
	createExecutePackageInvokeTools: vi.fn(),
	getCapabilityRegistryForContext: vi.fn(async () => ({
		capabilityHandlers: {
			kody_official_guide: true,
		},
	})),
}))

vi.mock('#mcp/run-codemode-registry.ts', () => ({
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

const { registerExecuteTool } = await import('./execute.ts')

const mockPerformanceNow = vi.spyOn(performance, 'now')

function mockPerformanceSequence(...values: Array<number>) {
	let index = 0
	mockPerformanceNow.mockImplementation(() => {
		const value = values[Math.min(index, values.length - 1)] ?? 0
		index += 1
		return value
	})
}

async function getExecuteHandler(
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
) {
	vi.clearAllMocks()
	const registerTool = vi.fn()

	await registerExecuteTool({
		server: {
			registerTool,
		} as never,
		getEnv: vi.fn(() => ({})),
		getCallerContext: vi.fn(() => callerContext),
		requireDomain: vi.fn(),
		getLoopbackExports: vi.fn(),
	} as never)

	expect(registerTool).toHaveBeenCalledTimes(1)
	const [, , handler] = registerTool.mock.calls[0] ?? []
	return handler as (input: {
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
		JSON.stringify({ __mcpContent: rawContent }),
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
					kody_official_guide: true,
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
		check: vi.fn(),
		invoke: vi.fn(),
		invokeChecked: vi.fn(),
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
		env: {},
		baseUrl: 'https://example.com',
		callerContext: expect.objectContaining(callerContext),
	})
	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining(callerContext),
		'export default async () => ({ ok: true })',
		undefined,
		expect.objectContaining({
			packageInvokeTools,
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
