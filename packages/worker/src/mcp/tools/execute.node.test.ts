import { expect, test, vi } from 'vitest'
import { registerExecuteTool } from './execute.ts'

test('registers execute tool', async () => {
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
	const [name, , handler] = registerTool.mock.calls[0] ?? []
	expect(name).toBe('execute')
	expect(typeof handler).toBe('function')
})
