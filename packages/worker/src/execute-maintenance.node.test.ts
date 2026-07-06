import { expect, test, vi } from 'vitest'

const createExecuteExecutorMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({
	exports: {
		KodyFetchGateway: () => ({}),
	},
}))

vi.mock('#mcp/executor.ts', () => ({
	createExecuteExecutor: (...args: Array<unknown>) =>
		createExecuteExecutorMock(...args),
}))

const { handleExecuteSmokeRequest, runExecuteSmokeCheck } =
	await import('./execute-maintenance.ts')

test('runExecuteSmokeCheck executes trivial code through the dynamic worker path', async () => {
	const execute = vi.fn(async () => ({ result: 42, logs: [] }))
	createExecuteExecutorMock.mockReturnValue({ execute })

	const env = {
		APP_BASE_URL: 'https://example.com',
		LOADER: {},
	} as Env

	await expect(runExecuteSmokeCheck(env)).resolves.toEqual({ result: 42 })
	expect(createExecuteExecutorMock).toHaveBeenCalledWith(
		expect.objectContaining({
			timeoutMs: 10_000,
			gatewayProps: {
				baseUrl: 'https://example.com',
				userId: null,
				storageContext: null,
			},
		}),
	)
	expect(execute).toHaveBeenCalledWith('async () => 42', [
		{
			name: 'kody',
			fns: {},
			kodyRemoteConnectors: [],
		},
	])
})

test('handleExecuteSmokeRequest enforces auth and reports smoke results', async () => {
	const execute = vi.fn(async () => ({ result: 42, logs: [] }))
	createExecuteExecutorMock.mockReturnValue({ execute })

	const env = {
		CAPABILITY_REINDEX_SECRET: 'secret',
		APP_BASE_URL: 'https://example.com',
		LOADER: {},
	} as Env

	const unauthorized = await handleExecuteSmokeRequest(
		new Request('https://example.com/__maintenance/execute-smoke', {
			method: 'POST',
		}),
		env,
	)
	expect(unauthorized.status).toBe(401)

	const success = await handleExecuteSmokeRequest(
		new Request('https://example.com/__maintenance/execute-smoke', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer secret',
			},
		}),
		env,
	)
	expect(success.status).toBe(200)
	await expect(success.json()).resolves.toEqual({
		ok: true,
		result: 42,
	})
})
