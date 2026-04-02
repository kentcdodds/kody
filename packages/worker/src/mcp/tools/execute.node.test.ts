import { expect, test, vi } from 'vitest'
import { registerExecuteTool } from './execute.ts'

test('registers the execute tool contract', async () => {
	const registerTool = vi.fn()

	await registerExecuteTool({
		server: {
			registerTool,
		} as never,
		getEnv: vi.fn(),
		getCallerContext: vi.fn(),
		requireDomain: vi.fn(),
		getLoopbackExports: vi.fn(),
	} as never)

	expect(registerTool).toHaveBeenCalledTimes(1)
	const [toolName, definition, handler] = registerTool.mock.calls[0] ?? []

	expect(toolName).toBe('execute')
	expect(definition).toMatchObject({
		title: 'Execute Capabilities',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
	})
	expect(typeof definition?.description).toBe('string')
	expect((definition?.description ?? '').length).toBeGreaterThan(0)
	expect(Object.keys(definition?.inputSchema ?? {})).toEqual([
		'code',
		'conversationId',
		'memoryContext',
	])
	expect(typeof handler).toBe('function')
})

test('memory context schema mentions current retrieval behavior', async () => {
	const registerTool = vi.fn()

	await registerExecuteTool({
		server: {
			registerTool,
		} as never,
		getEnv: vi.fn(),
		getCallerContext: vi.fn(),
		requireDomain: vi.fn(),
		getLoopbackExports: vi.fn(),
	} as never)

	const [, definition] = registerTool.mock.calls[0] ?? []
	const schema = definition?.inputSchema as
		| {
				memoryContext?: {
					description?: string
				}
		  }
		| undefined

	expect(schema?.memoryContext?.description).toContain(
		'memory retrieval',
	)
	expect(schema?.memoryContext?.description).toContain(
		'meta_memory_verify',
	)
})
