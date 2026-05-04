import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	runModuleWithRegistry: vi.fn(),
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

async function getExecuteHandler() {
	vi.clearAllMocks()
	const registerTool = vi.fn()

	await registerExecuteTool({
		server: {
			registerTool,
		} as never,
		getEnv: vi.fn(() => ({})),
		getCallerContext: vi.fn(() => ({
			baseUrl: 'https://example.com',
			user: null,
		})),
		requireDomain: vi.fn(),
		getLoopbackExports: vi.fn(),
	} as never)

	expect(registerTool).toHaveBeenCalledTimes(1)
	const [name, , handler] = registerTool.mock.calls[0] ?? []
	expect(name).toBe('execute')
	expect(typeof handler).toBe('function')
	return handler as (input: {
		code: string
		storageId?: string
		writable?: boolean
		conversationId?: string
	}) => Promise<{
		content: Array<ContentBlock>
		structuredContent: {
			conversationId: string
			storage?: { id: string }
			timing: {
				startedAt: string
				endedAt: string
				durationMs: number
			}
			result: unknown
			logs: Array<unknown>
		}
		isError: boolean
	}>
}

test('execute tool passes through raw MCP content blocks in success responses', async () => {
	const handler = await getExecuteHandler()
	mockPerformanceSequence(100, 142)
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
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			__mcpContent: rawContent,
		},
		logs: [{ level: 'info', message: 'captured screenshot' }],
	})

	const response = await handler({
		code: 'async () => ({ __mcpContent: [] })',
		conversationId: 'conv-123',
	})

	expect(response.isError).toBe(false)
	expect(response.content).toEqual([
		{
			type: 'text',
			text: 'conversationId: conv-123',
		},
		...rawContent,
	])
	expect(response.structuredContent).toEqual({
		conversationId: 'conv-123',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 42,
		},
		result: null,
		logs: [{ level: 'info', message: 'captured screenshot' }],
	})
})

test('execute tool keeps serializing normal success results as text', async () => {
	const handler = await getExecuteHandler()
	mockPerformanceSequence(10, 19)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})

	const response = await handler({
		code: 'async () => ({ ok: true })',
		conversationId: 'conv-456',
	})

	expect(response.isError).toBe(false)
	expect(response.content).toEqual([
		{
			type: 'text',
			text: 'conversationId: conv-456',
		},
		{
			type: 'text',
			text: '{\n  "ok": true\n}',
		},
	])
	expect(response.structuredContent).toEqual({
		conversationId: 'conv-456',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 9,
		},
		result: { ok: true },
		logs: [],
	})
})

test('execute tool binds storage id and writable flag when provided', async () => {
	const handler = await getExecuteHandler()
	mockPerformanceSequence(1, 8)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})

	const response = await handler({
		code: 'async () => ({ ok: true })',
		storageId: 'job:lights-off',
		writable: true,
		conversationId: 'conv-789',
	})

	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledWith(
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
	expect(response.structuredContent).toEqual({
		conversationId: 'conv-789',
		storage: { id: 'job:lights-off' },
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 7,
		},
		result: { ok: true },
		logs: [],
	})
})

test('execute tool includes timing metadata in error responses', async () => {
	const handler = await getExecuteHandler()
	mockPerformanceSequence(50, 65)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		error: new Error('Boom'),
		logs: [{ level: 'error', message: 'failed' }],
	})

	const response = await handler({
		code: 'async () => { throw new Error("Boom") }',
		conversationId: 'conv-error',
	})

	expect(response.isError).toBe(true)
	expect(response.structuredContent).toEqual(
		expect.objectContaining({
			conversationId: 'conv-error',
			timing: {
				startedAt: expect.any(String),
				endedAt: expect.any(String),
				durationMs: 15,
			},
			error: 'Boom',
			logs: [{ level: 'error', message: 'failed' }],
		}),
	)
})
