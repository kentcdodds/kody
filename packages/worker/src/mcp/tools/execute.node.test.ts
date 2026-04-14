import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	runCodemodeWithRegistry: vi.fn(),
	getCapabilityRegistryForContext: vi.fn(async () => ({
		capabilityHandlers: {
			page_to_markdown: true,
		},
	})),
}))

vi.mock('#mcp/run-codemode-registry.ts', () => ({
	runCodemodeWithRegistry: (...args: Array<unknown>) =>
		mockModule.runCodemodeWithRegistry(...args),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (...args: Array<unknown>) =>
		mockModule.getCapabilityRegistryForContext(...args),
}))

const { registerExecuteTool } = await import('./execute.ts')

beforeEach(() => {
	vi.clearAllMocks()
})

async function getExecuteHandler() {
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
			result: unknown
			logs: Array<unknown>
		}
		isError: boolean
	}>
}

test('registers execute tool', async () => {
	await getExecuteHandler()
})

test('execute tool passes through raw MCP content blocks in success responses', async () => {
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
	mockModule.runCodemodeWithRegistry.mockResolvedValueOnce({
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
		result: null,
		logs: [{ level: 'info', message: 'captured screenshot' }],
	})
})

test('execute tool keeps serializing normal success results as text', async () => {
	const handler = await getExecuteHandler()
	mockModule.runCodemodeWithRegistry.mockResolvedValueOnce({
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
		result: { ok: true },
		logs: [],
	})
})

test('execute tool binds storage id and writable flag when provided', async () => {
	const handler = await getExecuteHandler()
	mockModule.runCodemodeWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})

	const response = await handler({
		code: 'async () => ({ ok: true })',
		storageId: 'job:lights-off',
		writable: true,
		conversationId: 'conv-789',
	})

	expect(mockModule.runCodemodeWithRegistry).toHaveBeenCalledWith(
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
		result: { ok: true },
		logs: [],
	})
})
