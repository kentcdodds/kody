import { expect, test } from 'vitest'
import {
	callerDisconnectedSandboxLog,
	callerDisconnectedSandboxMessage,
	packageInvocationClientDisconnectedErrorName,
} from '#worker/caller-disconnect.ts'
import { createExecuteExecutor, createNamedExecutionError } from './executor.ts'

type FakeWorkerOptions = Record<string, unknown>

function createExecutorTestEnv(loader: Env['LOADER']) {
	return {
		LOADER: loader,
		APP_COMMIT_SHA: 'commit-for-test',
	} as Env
}

function createExecutorTestExports() {
	return {
		KodyFetchGateway: ({ props }: { props: unknown }) => ({ props }),
	} as never
}

function createGatewayProps(userId: string) {
	return {
		baseUrl: 'https://heykody.dev',
		userId,
		email: `${userId}@example.com`,
		storageContext: null,
	}
}

test('createExecuteExecutor finishes with a disconnect error when the caller abort fires', async () => {
	const caller = new AbortController()
	const loader = {
		get(_id: string, factory: () => FakeWorkerOptions) {
			factory()
			return {
				getEntrypoint() {
					return {
						async evaluate() {
							await new Promise(() => {})
							return { result: 'unexpected', logs: [] }
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	const pending = createExecuteExecutor({
		env: createExecutorTestEnv(loader),
		exports: createExecutorTestExports(),
		gatewayProps: createGatewayProps('disconnect-user'),
		timeoutMs: 30_000,
		signal: caller.signal,
	}).execute('async () => "never"', [])
	caller.abort()
	const result = await pending
	expect(result.error).toBe(callerDisconnectedSandboxMessage)
	expect(result.logs).toEqual([callerDisconnectedSandboxLog])
	expect(createNamedExecutionError(result.error).name).toBe(
		packageInvocationClientDisconnectedErrorName,
	)
})
