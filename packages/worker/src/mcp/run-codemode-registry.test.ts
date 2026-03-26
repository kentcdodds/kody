import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const { executeMock, wrapExecuteCodeMock } = vi.hoisted(() => {
	return {
		executeMock: vi.fn(async () => ({ result: 'ok' })),
		wrapExecuteCodeMock: vi.fn((code: string) => `wrapped:${code}`),
	}
})

vi.mock('#mcp/executor.ts', () => ({
	createExecuteExecutor: () => ({
		execute: executeMock,
	}),
	wrapExecuteCode: wrapExecuteCodeMock,
}))

const { buildCodemodeProvider, runCodemodeWithRegistry } =
	await import('./run-codemode-registry.ts')

test('buildCodemodeProvider resolves the codemode namespace for executor.execute', async () => {
	const provider = await buildCodemodeProvider(
		{} as Env,
		createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
		}),
	)

	expect(provider.name).toBe('codemode')
	expect(provider.fns.meta_list_capabilities).toBeTypeOf('function')

	const result = await provider.fns.meta_list_capabilities({
		domain: 'meta',
	})

	expect(result).toMatchObject({
		total: expect.any(Number),
		capabilities: expect.arrayContaining([
			expect.objectContaining({
				name: 'meta_list_capabilities',
				domain: 'meta',
			}),
		]),
	})
})

test('runCodemodeWithRegistry passes a resolved provider array to executor.execute', async () => {
	executeMock.mockClear()
	wrapExecuteCodeMock.mockClear()

	const result = await runCodemodeWithRegistry(
		{} as Env,
		createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
		}),
		'async () => "done"',
	)

	expect(result).toEqual({ result: 'ok' })
	expect(wrapExecuteCodeMock).toHaveBeenCalledWith('async () => "done"')
	expect(executeMock).toHaveBeenCalledTimes(1)

	const [wrappedCode, providers] = executeMock.mock.calls[0]!
	expect(wrappedCode).toBe('wrapped:async () => "done"')
	expect(Array.isArray(providers)).toBe(true)
	expect(providers).toHaveLength(1)
	expect(providers[0]).toMatchObject({
		name: 'codemode',
	})
	expect(providers[0]?.fns.meta_list_capabilities).toBeTypeOf('function')
})
