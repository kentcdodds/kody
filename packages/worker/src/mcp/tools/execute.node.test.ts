import { expect, test, vi } from 'vitest'
import { registerExecuteTool } from './execute.ts'

test('execute tool description encourages fewer execute calls', async () => {
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
	expect(registerTool.mock.calls[0]?.[0]).toBe('execute')
	expect(registerTool.mock.calls[0]?.[1]?.description).toContain(
		'Prefer fewer `execute` tool invocations when the workflow is clear.',
	)
	expect(registerTool.mock.calls[0]?.[1]?.description).toContain(
		'chain the capability calls there and return the final useful result',
	)
})
