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
	expect(definition?.description).toContain(
		'Never place placeholder text into user-visible or third-party-visible content',
	)
	expect(definition?.description).toContain(
		'issue bodies, comments, prompts, logs, or returned strings',
	)
	expect(Object.keys(definition?.inputSchema ?? {})).toEqual([
		'code',
		'conversationId',
		'memoryContext',
	])
	expect(typeof handler).toBe('function')
})
