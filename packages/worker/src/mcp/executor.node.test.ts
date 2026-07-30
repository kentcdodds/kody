import { expect, test } from 'vitest'
import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import {
	createCapabilitySecretAccessDeniedBatchMessage,
	createCapabilitySecretAccessDeniedMessage,
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
	createPackageSecretAccessDeniedBatchMessage,
} from '#mcp/secrets/errors.ts'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import { createUnboundRuntimeHelperMessage } from '#worker/package-runtime/unbound-runtime-helpers.ts'
import { createStorageEstimateReadError } from '#worker/storage-estimate-error.ts'
import {
	createKodyRemoteProxy,
	createKodyProviderProxySource,
	createExecuteExecutor,
	createExecutorModuleSource,
	createToolDispatchers,
	extractRawContent,
	formatExecutionOutput,
	formatLimitedExecutionOutput,
	getExecutionErrorDetails,
	limitExecutionResultValue,
	raceWithHostEvaluationDeadline,
	runWithDynamicWorkerEvaluationBudget,
} from './executor.ts'
import { executorSandboxTimeoutMessage } from '#worker/sentry-options.ts'
import { assertGeneratedExecutorSourceIsBundleSafe } from './kody-remote-proxy-source.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'

type FakeWorkerOptions = Record<string, unknown>

function createFakeWorkerLoader() {
	const ids: Array<string> = []
	const createdOptions = new Map<string, FakeWorkerOptions>()
	const evaluations: Array<
		Record<string, { call: typeof ToolDispatcherCall }>
	> = []
	let factoryCallCount = 0
	const loader = {
		get(id: string, factory: () => FakeWorkerOptions) {
			ids.push(id)
			let options = createdOptions.get(id)
			if (!options) {
				factoryCallCount += 1
				options = factory()
				createdOptions.set(id, options)
			}
			return {
				getEntrypoint() {
					return {
						async evaluate(
							dispatchers: Record<string, { call: typeof ToolDispatcherCall }>,
						) {
							evaluations.push(dispatchers)
							return {
								result: id,
								logs: [],
							}
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	return {
		loader,
		ids,
		createdOptions,
		evaluations,
		get factoryCallCount() {
			return factoryCallCount
		},
	}
}

async function ToolDispatcherCall(_name: string, _argsJson: string) {
	return ''
}

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
		storageContext: null,
	}
}

test('kody remote proxy dispatches and reports connector/capability errors clearly', async () => {
	const calls: Array<{ dispatchName: string; args: unknown }> = []
	const remote = createKodyRemoteProxy({
		remoteConnectors: [
			{
				name: 'home',
				instanceId: 'home',
				status: {
					state: 'connected',
					connected: true,
					toolCount: 1,
					message: 'The connector "home" is connected.',
					unavailableMessage: 'The connector "home" is connected.',
				},
				capabilities: [
					{
						name: 'set_pin',
						dispatchName: 'remotehomeset_pin',
					},
				],
			},
			{
				name: 'lights',
				instanceId: 'home',
				status: {
					state: 'disconnected',
					connected: false,
					toolCount: 0,
					message: 'The connector "home" is not connected.',
					unavailableMessage:
						'The connector "home" is not connected. Kody cannot use this connector until it reconnects.',
				},
				capabilities: [],
			},
		],
		async callTool(dispatchName, args) {
			calls.push({ dispatchName, args })
			return { ok: true }
		},
	}) as Record<string, Record<string, (args: unknown) => Promise<unknown>>>

	await expect(remote['home']?.set_pin({ pin: '1234' })).resolves.toEqual({
		ok: true,
	})
	expect(calls).toEqual([
		{
			dispatchName: 'remotehomeset_pin',
			args: { pin: '1234' },
		},
	])
	expect(() => remote['missing']).toThrow(
		'Unknown remote connector "missing". Available remote connectors: "home", "lights".',
	)
	expect(() => remote['home']?.missing_tool).toThrow(
		'Unknown remote capability "missing_tool" for connector "home". Available capabilities: "set_pin".',
	)
	expect(() => remote['lights']?.set_pin).toThrow(
		'The connector "home" is not connected. Kody cannot use this connector until it reconnects.',
	)
})

test('generated kody provider source projects remote proxy metadata', () => {
	const source = createKodyProviderProxySource({
		providerName: 'kody',
		remoteConnectors: [
			{
				name: 'home',
				instanceId: 'home-instance',
				status: {
					state: 'connected',
					connected: true,
					toolCount: 1,
					message: 'The connector "home" is connected.',
					unavailableMessage: 'The connector "home" is connected.',
				},
				capabilities: [
					{
						name: 'set_pin',
						dispatchName: 'remotehomeset_pin',
					},
				],
			},
		],
		mcpServers: [
			{
				name: 'docs',
				serverId: 'docs-server',
				status: {
					state: 'connected',
					connected: true,
					toolCount: 2,
					message: 'The MCP server "docs" is connected.',
					unavailableMessage: 'The MCP server "docs" is connected.',
				},
				capabilities: [
					{
						name: 'search',
						dispatchName: 'mcpdocssearch',
					},
				],
			},
		],
		openApiProviders: [
			{
				name: 'widgets',
				bindingName: 'widgets-binding',
				status: {
					state: 'connected',
					connected: true,
					toolCount: 1,
					message: 'The OpenAPI provider "widgets" is connected.',
					unavailableMessage: 'The OpenAPI provider "widgets" is connected.',
				},
				capabilities: [
					{
						name: 'listwidgets',
						dispatchName: 'openapiwidgetslistwidgets',
					},
				],
			},
		],
	})

	expect(source).not.toContain('"instanceId"')
	expect(source).not.toContain('"serverId"')
	expect(source).not.toContain('"bindingName"')
	expect(source).not.toContain('"state":')
	expect(source).not.toContain('"message":')
	expect(source).toContain('"unavailableMessage":')
	expect(source).toContain('"toolCount":')
	expect(source).toContain('"dispatchName":"remotehomeset_pin"')
	expect(source).toContain('"dispatchName":"mcpdocssearch"')
	expect(source).toContain('"dispatchName":"openapiwidgetslistwidgets"')
})

test('generated kody provider source ignores volatile metadata fields for script identity', () => {
	const baseConnectors = [
		{
			name: 'home',
			instanceId: 'home-a',
			status: {
				state: 'connected',
				connected: true,
				toolCount: 1,
				message: 'status prose A',
				unavailableMessage: 'The connector "home" is connected.',
			},
			capabilities: [
				{
					name: 'set_pin',
					dispatchName: 'remotehomeset_pin',
				},
			],
		},
	] as const
	const first = createKodyProviderProxySource({
		providerName: 'kody',
		remoteConnectors: [...baseConnectors],
	})
	const second = createKodyProviderProxySource({
		providerName: 'kody',
		remoteConnectors: [
			{
				...baseConnectors[0],
				instanceId: 'home-b',
				status: {
					...baseConnectors[0].status,
					state: 'degraded',
					message: 'status prose B — different volatile text',
				},
			},
		],
	})
	expect(second).toBe(first)
})

test('generated kody provider source avoids bundle-scoped __name helpers', () => {
	const source = createKodyProviderProxySource({
		providerName: 'kody',
		remoteConnectors: [],
	})
	expect(source).not.toMatch(/\b__name\b/u)
	assertGeneratedExecutorSourceIsBundleSafe(source)

	const bundledFactorySource = `const __kodyCreateRemoteProxy = __name(function createKodyRemoteProxy() { return {}; }, "createKodyRemoteProxy");`
	expect(bundledFactorySource).toMatch(/\b__name\b/u)
	expect(() => new Function('__dispatchers', bundledFactorySource)({})).toThrow(
		/__name is not defined/u,
	)

	const moduleSource = createExecutorModuleSource({
		code: 'async () => "ok"',
		providers: [
			{
				name: 'kody',
				fns: {},
				kodyRemoteConnectors: [],
			},
		],
		shadowGlobalThis: false,
		timeoutMs: 1_000,
	})
	assertGeneratedExecutorSourceIsBundleSafe(moduleSource)
})

test('generated kody provider source wires remote proxy dispatch', async () => {
	const calls: Array<{ name: string; argsJson: string }> = []
	const source = createKodyProviderProxySource({
		providerName: 'kody',
		remoteConnectors: [
			{
				name: 'home',
				instanceId: 'home',
				status: {
					state: 'connected',
					connected: true,
					toolCount: 1,
					message: 'The connector "home" is connected.',
					unavailableMessage: 'The connector "home" is connected.',
				},
				capabilities: [
					{
						name: 'set_pin',
						dispatchName: 'remotehomeset_pin',
					},
				],
			},
		],
	})
	const kody = new Function('__dispatchers', `${source}; return kody;`)({
		kody: {
			async call(name: string, argsJson: string) {
				calls.push({ name, argsJson })
				return JSON.stringify({ result: { ok: true } })
			},
		},
	}) as {
		remote: Record<string, Record<string, (args: unknown) => Promise<unknown>>>
		[key: string]: unknown
	}

	await expect(kody.remote['home']?.set_pin({ pin: '1234' })).resolves.toEqual({
		ok: true,
	})
	expect(calls).toEqual([
		{
			name: 'remotehomeset_pin',
			argsJson: JSON.stringify({ pin: '1234' }),
		},
	])
	expect(() => kody['remote:home:set_pin']).toThrow(
		'Remote connector capability "remote:home:set_pin" is not available as a flat kody function.',
	)
})

test('generated kody provider source wires openapi proxy dispatch', async () => {
	const calls: Array<{ name: string; argsJson: string }> = []
	const source = createKodyProviderProxySource({
		providerName: 'kody',
		remoteConnectors: [],
		openApiProviders: [
			{
				name: 'widgets',
				bindingName: 'widgets',
				status: {
					state: 'connected',
					connected: true,
					toolCount: 1,
					message: 'The OpenAPI provider "widgets" is connected.',
					unavailableMessage: 'The OpenAPI provider "widgets" is connected.',
				},
				capabilities: [
					{
						name: 'listwidgets',
						dispatchName: 'openapiwidgetslistwidgets',
					},
				],
			},
		],
	})
	const kody = new Function('__dispatchers', `${source}; return kody;`)({
		kody: {
			async call(name: string, argsJson: string) {
				calls.push({ name, argsJson })
				return JSON.stringify({ result: { ok: true } })
			},
		},
	}) as {
		openapi: Record<string, Record<string, (args: unknown) => Promise<unknown>>>
		[key: string]: unknown
	}

	await expect(
		kody.openapi['widgets']?.listwidgets({ query: { limit: 1 } }),
	).resolves.toEqual({ ok: true })
	expect(calls).toEqual([
		{
			name: 'openapiwidgetslistwidgets',
			argsJson: JSON.stringify({ query: { limit: 1 } }),
		},
	])
	expect(() => kody.openapi['missing']).toThrow(
		'Unknown OpenAPI provider "missing". Available OpenAPI providers: "widgets".',
	)
	expect(() => kody.openapi['widgets']?.missing_op).toThrow(
		'Unknown operation "missing_op" for provider "widgets". Available capabilities: "listwidgets".',
	)
	expect(() => kody['openapi:widgets:listwidgets']).toThrow(
		'OpenAPI operation "openapi:widgets:listwidgets" is not available as a flat kody function. Use kody.openapi[providerName].operationSlug(input) instead.',
	)
})

test('createExecuteExecutor aligns dynamic worker compatibility with shared options', async () => {
	const fakeLoader = createFakeWorkerLoader()
	await createExecuteExecutor({
		env: createExecutorTestEnv(fakeLoader.loader),
		exports: createExecutorTestExports(),
		gatewayProps: createGatewayProps('user-1'),
	}).execute('async () => "ok"', [{ name: 'kody', fns: {} }])

	const workerOptions = fakeLoader.createdOptions.get(fakeLoader.ids[0]!)
	expect(workerOptions).toMatchObject(createDynamicWorkerCompatibilityOptions())
})

test('explicit request budgets cap independent roots at four without blocking separate requests', async () => {
	type BudgetState = {
		active: number
		maxActive: number
		started: number
		releases: Array<() => void>
	}
	const createBudgetState = (): BudgetState => ({
		active: 0,
		maxActive: 0,
		started: 0,
		releases: [],
	})
	const createBlockingLoader = (state: BudgetState) =>
		({
			get(_id: string, factory: () => FakeWorkerOptions) {
				factory()
				return {
					getEntrypoint() {
						return {
							async evaluate() {
								state.started += 1
								state.active += 1
								state.maxActive = Math.max(state.maxActive, state.active)
								await new Promise<void>((resolve) => {
									state.releases.push(() => {
										state.active -= 1
										resolve()
									})
								})
								return { result: 'done', logs: [] }
							},
						}
					},
				}
			},
		}) as unknown as Env['LOADER']
	const exports = createExecutorTestExports()
	const providers = [{ name: 'kody', fns: {} }]
	const runFiveRoots = (userId: string, state: BudgetState) =>
		runWithDynamicWorkerEvaluationBudget(
			async () =>
				await Promise.all(
					Array.from({ length: 5 }, async (_, index) => {
						return await createExecuteExecutor({
							env: createExecutorTestEnv(createBlockingLoader(state)),
							exports,
							gatewayProps: createGatewayProps(userId),
						}).execute(`async () => ${index}`, providers)
					}),
				),
		)

	const firstState = createBudgetState()
	const firstRequest = runFiveRoots('first-request-user', firstState)
	await expect.poll(() => firstState.started).toBe(4)
	expect(firstState.active).toBe(4)
	expect(firstState.maxActive).toBe(4)

	const secondState = createBudgetState()
	const secondRequest = runFiveRoots('second-request-user', secondState)
	await expect.poll(() => secondState.started).toBe(4)
	expect(secondState.active).toBe(4)
	expect(secondState.maxActive).toBe(4)

	firstState.releases.shift()?.()
	secondState.releases.shift()?.()
	await expect.poll(() => firstState.started).toBe(5)
	await expect.poll(() => secondState.started).toBe(5)
	expect(firstState.active).toBe(4)
	expect(secondState.active).toBe(4)

	for (const release of firstState.releases.splice(0)) release()
	for (const release of secondState.releases.splice(0)) release()
	await expect(firstRequest).resolves.toHaveLength(5)
	await expect(secondRequest).resolves.toHaveLength(5)
	expect(firstState.active).toBe(0)
	expect(secondState.active).toBe(0)
})

test('raceWithHostEvaluationDeadline rejects when evaluate never settles', async () => {
	const startedAtMs = Date.now()
	await expect(
		raceWithHostEvaluationDeadline(async () => await new Promise(() => {}), 40),
	).rejects.toThrow(executorSandboxTimeoutMessage)
	expect(Date.now() - startedAtMs).toBeLessThan(500)
})

test('createExecuteExecutor returns sandbox timeout when Loader evaluate hangs', async () => {
	const loader = {
		get(_id: string, factory: () => FakeWorkerOptions) {
			factory()
			return {
				getEntrypoint() {
					return {
						async evaluate() {
							return await new Promise(() => {})
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	const env = createExecutorTestEnv(loader)
	const startedAtMs = Date.now()
	const result = await createExecuteExecutor({
		env,
		exports: createExecutorTestExports(),
		gatewayProps: createGatewayProps('hang-user'),
		timeoutMs: 40,
	}).execute('async () => "never"', [{ name: 'kody', fns: {} }])
	expect(result.error).toBe(executorSandboxTimeoutMessage)
	expect(result.result).toBeUndefined()
	expect(Date.now() - startedAtMs).toBeLessThan(500)
})

test('createExecuteExecutor drops queued evaluations when the host deadline expires', async () => {
	let evaluateStarts = 0
	let releaseHolders: () => void = () => {}
	const holdersMayFinish = new Promise<void>((resolve) => {
		releaseHolders = resolve
	})
	let resolveAllHoldersStarted: () => void = () => {}
	const allHoldersStarted = new Promise<void>((resolve) => {
		resolveAllHoldersStarted = resolve
	})
	let sharedEnv: Env
	const exports = createExecutorTestExports()
	const providers = [{ name: 'kody', fns: {} }]
	const loader = {
		get(_id: string, factory: () => FakeWorkerOptions) {
			factory()
			return {
				getEntrypoint() {
					return {
						async evaluate() {
							evaluateStarts += 1
							if (evaluateStarts === 4) resolveAllHoldersStarted()
							await holdersMayFinish
							return { result: 'done', logs: [] }
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	sharedEnv = createExecutorTestEnv(loader)

	await runWithDynamicWorkerEvaluationBudget(async () => {
		const holders = Array.from({ length: 4 }, () =>
			createExecuteExecutor({
				env: sharedEnv,
				exports,
				gatewayProps: createGatewayProps('queue-user'),
				timeoutMs: 10_000,
			}).execute('async () => "holder"', providers),
		)
		await allHoldersStarted
		expect(evaluateStarts).toBe(4)

		const queuedResult = await createExecuteExecutor({
			env: sharedEnv,
			exports,
			gatewayProps: createGatewayProps('queue-user'),
			timeoutMs: 40,
		}).execute('async () => "queued"', providers)

		expect(queuedResult.error).toBe(executorSandboxTimeoutMessage)
		expect(evaluateStarts).toBe(4)

		releaseHolders()
		await Promise.all(holders)
		expect(evaluateStarts).toBe(4)
	})
})

test('createExecuteExecutor fails fast when nested fan-out saturates its request budget', async () => {
	let evaluationCount = 0
	let maxActiveEvaluations = 0
	let activeEvaluations = 0
	let releaseChildren: () => void = () => {}
	const childrenMayFinish = new Promise<void>((resolve) => {
		releaseChildren = resolve
	})
	let nestedEnv: Env
	const exports = createExecutorTestExports()
	const providers = [{ name: 'kody', fns: {} }]
	const loader = {
		get(_id: string, factory: () => FakeWorkerOptions) {
			factory()
			return {
				getEntrypoint() {
					return {
						async evaluate() {
							evaluationCount += 1
							activeEvaluations += 1
							maxActiveEvaluations = Math.max(
								maxActiveEvaluations,
								activeEvaluations,
							)
							if (evaluationCount === 1) {
								return await Promise.all(
									Array.from({ length: 5 }, async (_, index) => {
										return await createExecuteExecutor({
											env: nestedEnv,
											exports,
											gatewayProps: createGatewayProps('nested-user'),
										}).execute(`async () => ${index}`, providers)
									}),
								)
							}
							await childrenMayFinish
							activeEvaluations -= 1
							return { result: 'child', logs: [] }
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	nestedEnv = createExecutorTestEnv(loader)

	const rootExecution = createExecuteExecutor({
		env: nestedEnv,
		exports,
		gatewayProps: createGatewayProps('nested-user'),
	}).execute('async () => "root"', providers)

	await expect(rootExecution).rejects.toThrow(
		'Dynamic worker concurrency limit exceeded: each request may have up to 4 concurrent dynamic worker invocations.',
	)
	releaseChildren()
	expect(evaluationCount).toBe(4)
	expect(maxActiveEvaluations).toBe(4)
})

test('createExecuteExecutor fails fast instead of deadlocking recursive evaluations beyond four', async () => {
	let evaluationCount = 0
	let recursiveEnv: Env
	const exports = createExecutorTestExports()
	const providers = [{ name: 'kody', fns: {} }]
	const loader = {
		get(_id: string, factory: () => FakeWorkerOptions) {
			factory()
			return {
				getEntrypoint() {
					return {
						async evaluate() {
							evaluationCount += 1
							return await createExecuteExecutor({
								env: recursiveEnv,
								exports,
								gatewayProps: createGatewayProps('recursive-user'),
							}).execute(`async () => ${evaluationCount}`, providers)
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	recursiveEnv = createExecutorTestEnv(loader)

	const startedAtMs = Date.now()
	await expect(
		createExecuteExecutor({
			env: recursiveEnv,
			exports,
			gatewayProps: createGatewayProps('recursive-user'),
		}).execute('async () => "root"', providers),
	).rejects.toThrow(
		'Dynamic worker concurrency limit exceeded: each request may have up to 4 concurrent dynamic worker invocations.',
	)
	expect(Date.now() - startedAtMs).toBeLessThan(1_000)
	expect(evaluationCount).toBe(4)
})

test('createExecuteExecutor fails fast when saturated sibling evaluations recurse together', async () => {
	let evaluationCount = 0
	let childCount = 0
	let releaseChildren: () => void = () => {}
	const allChildrenStarted = new Promise<void>((resolve) => {
		releaseChildren = resolve
	})
	let recursiveEnv: Env
	const exports = createExecutorTestExports()
	const providers = [{ name: 'kody', fns: {} }]
	const loader = {
		get(_id: string, factory: () => FakeWorkerOptions) {
			const options = factory()
			const serializedOptions = JSON.stringify(options)
			const kind = serializedOptions.includes('root-marker')
				? 'root'
				: serializedOptions.includes('child-marker')
					? 'child'
					: 'descendant'
			return {
				getEntrypoint() {
					return {
						async evaluate() {
							evaluationCount += 1
							if (kind === 'root') {
								return await Promise.all(
									Array.from({ length: 3 }, async (_, index) =>
										createExecuteExecutor({
											env: recursiveEnv,
											exports,
											gatewayProps: createGatewayProps('mixed-user'),
										}).execute(
											`async () => "child-marker-${index}"`,
											providers,
										),
									),
								)
							}
							if (kind === 'child') {
								childCount += 1
								if (childCount === 3) releaseChildren()
								await allChildrenStarted
								return await createExecuteExecutor({
									env: recursiveEnv,
									exports,
									gatewayProps: createGatewayProps('mixed-user'),
								}).execute('async () => "descendant-marker"', providers)
							}
							return { result: 'descendant', logs: [] }
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	recursiveEnv = createExecutorTestEnv(loader)

	const startedAtMs = Date.now()
	await expect(
		createExecuteExecutor({
			env: recursiveEnv,
			exports,
			gatewayProps: createGatewayProps('mixed-user'),
		}).execute('async () => "root-marker"', providers),
	).rejects.toThrow(
		'Dynamic worker concurrency limit exceeded: each request may have up to 4 concurrent dynamic worker invocations.',
	)
	expect(Date.now() - startedAtMs).toBeLessThan(1_000)
	expect(evaluationCount).toBe(4)
})

test('createExecuteExecutor reuses stable dynamic worker ids until binding context or module graph changes', async () => {
	const fakeLoader = createFakeWorkerLoader()
	const env = createExecutorTestEnv(fakeLoader.loader)
	const exports = createExecutorTestExports()
	const providers = [
		{
			name: 'kody',
			fns: {
				search: async () => ({ ok: true }),
			},
		},
	]

	const first = await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-1'),
	}).execute('async () => "ok"', providers)
	const second = await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-1'),
	}).execute('async () => "ok"', [
		{
			name: 'kody',
			fns: {
				search: async () => ({ ok: 'different dispatcher same worker' }),
			},
		},
	])

	expect(first.result).toBe(second.result)
	expect(fakeLoader.ids).toHaveLength(2)
	expect(new Set(fakeLoader.ids).size).toBe(1)
	expect(fakeLoader.factoryCallCount).toBe(1)

	const scopedProviders = [
		{
			name: 'kody',
			fns: {},
		},
	]

	await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-1'),
		modules: {
			'helper.js': 'export const value = "one";',
		},
	}).execute('async () => "ok"', scopedProviders)
	await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-2'),
		modules: {
			'helper.js': 'export const value = "one";',
		},
	}).execute('async () => "ok"', scopedProviders)
	await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-1'),
		modules: {
			'helper.js': 'export const value = "two";',
		},
	}).execute('async () => "ok"', scopedProviders)

	expect(fakeLoader.ids).toHaveLength(5)
	expect(new Set(fakeLoader.ids).size).toBe(4)
	expect(fakeLoader.factoryCallCount).toBe(4)

	const noUserLoader = createFakeWorkerLoader()
	const noUserGatewayProps = {
		...createGatewayProps('user-1'),
		userId: null,
	}
	for (let index = 0; index < 2; index += 1) {
		await createExecuteExecutor({
			env: createExecutorTestEnv(noUserLoader.loader),
			exports,
			gatewayProps: noUserGatewayProps,
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(noUserLoader.ids).toHaveLength(2)
	expect(new Set(noUserLoader.ids).size).toBe(2)
	expect(noUserLoader.factoryCallCount).toBe(2)

	const noCommitLoader = createFakeWorkerLoader()
	const noCommitEnv = {
		...createExecutorTestEnv(noCommitLoader.loader),
		APP_COMMIT_SHA: undefined,
	} as Env
	for (let index = 0; index < 2; index += 1) {
		await createExecuteExecutor({
			env: noCommitEnv,
			exports,
			gatewayProps: createGatewayProps('user-1'),
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(noCommitLoader.ids).toHaveLength(2)
	expect(new Set(noCommitLoader.ids).size).toBe(2)
	expect(noCommitLoader.factoryCallCount).toBe(2)

	const bundledLoader = createFakeWorkerLoader()
	for (let index = 0; index < 2; index += 1) {
		await createExecuteExecutor({
			env: createExecutorTestEnv(bundledLoader.loader),
			exports,
			gatewayProps: createGatewayProps('user-1'),
			modules: {
				'entry.js': 'export default async function main() { return "ok" }',
			},
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(bundledLoader.ids).toHaveLength(2)
	expect(new Set(bundledLoader.ids).size).toBe(1)
	expect(bundledLoader.factoryCallCount).toBe(1)

	const differentUserBundledLoader = createFakeWorkerLoader()
	for (const userId of ['user-1', 'user-2']) {
		await createExecuteExecutor({
			env: createExecutorTestEnv(differentUserBundledLoader.loader),
			exports,
			gatewayProps: createGatewayProps(userId),
			modules: {
				'entry.js': 'export default async function main() { return "ok" }',
			},
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(differentUserBundledLoader.ids).toHaveLength(2)
	expect(new Set(differentUserBundledLoader.ids).size).toBe(2)
	expect(differentUserBundledLoader.factoryCallCount).toBe(2)

	const differentStorageLoader = createFakeWorkerLoader()
	const storageContexts = [
		null,
		{ sessionId: 'session-1', appId: 'app-1', storageId: 'storage-1' },
	] as const
	for (const storageContext of storageContexts) {
		await createExecuteExecutor({
			env: createExecutorTestEnv(differentStorageLoader.loader),
			exports,
			gatewayProps: {
				...createGatewayProps('user-1'),
				storageContext,
			},
			modules: {
				'entry.js': 'export default async function main() { return "ok" }',
			},
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(differentStorageLoader.ids).toHaveLength(2)
	expect(new Set(differentStorageLoader.ids).size).toBe(2)
	expect(differentStorageLoader.factoryCallCount).toBe(2)

	const nonHashableModuleLoader = createFakeWorkerLoader()
	for (let index = 0; index < 2; index += 1) {
		await createExecuteExecutor({
			env: createExecutorTestEnv(nonHashableModuleLoader.loader),
			exports,
			gatewayProps: createGatewayProps('user-1'),
			modules: {
				'entry.js': {
					js: 'export default async function main() { return "ok" }',
					onLoad: async () => 'not-hashable',
				},
			},
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(nonHashableModuleLoader.ids).toHaveLength(2)
	expect(new Set(nonHashableModuleLoader.ids).size).toBe(2)
	expect(nonHashableModuleLoader.factoryCallCount).toBe(2)
})

test('createExecuteExecutor records one usage event per sandbox run with duration and outcome', async () => {
	const dataPoints: Array<AnalyticsEngineDataPoint> = []
	const rollupWrites: Array<Array<unknown>> = []
	const usageBindings = {
		USAGE_EVENTS: {
			writeDataPoint(point?: AnalyticsEngineDataPoint) {
				if (point) dataPoints.push(point)
			},
		},
		APP_DB: {
			prepare(_sql: string) {
				return {
					bind(...args: Array<unknown>) {
						return {
							async run() {
								rollupWrites.push(args)
								return {}
							},
						}
					},
				}
			},
		},
	}
	const exports = createExecutorTestExports()
	const providers = [{ name: 'kody', fns: {} }]

	// Successful sandbox run: one success event.
	const successLoader = createFakeWorkerLoader()
	await createExecuteExecutor({
		env: {
			...createExecutorTestEnv(successLoader.loader),
			...usageBindings,
		} as Env,
		exports,
		gatewayProps: createGatewayProps('usage-user-1'),
	}).execute('async () => "ok"', providers)

	expect(dataPoints).toHaveLength(1)
	expect(dataPoints[0]?.indexes).toEqual(['usage-user-1'])
	expect(dataPoints[0]?.blobs?.slice(0, 4)).toEqual([
		'usage-user-1',
		'execute',
		'',
		'success',
	])
	expect(dataPoints[0]?.doubles?.[0]).toBeGreaterThanOrEqual(0)
	// With USAGE_EVENTS present, rollups are derived from Analytics Engine
	// by the scheduled aggregation instead of a per-event D1 upsert.
	expect(rollupWrites).toHaveLength(0)

	// Sandbox run returning an error result: one error event.
	const errorLoader = {
		get() {
			return {
				getEntrypoint() {
					return {
						async evaluate() {
							return { result: undefined, error: 'boom', logs: [] }
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	const errorResult = await createExecuteExecutor({
		env: {
			...createExecutorTestEnv(errorLoader),
			...usageBindings,
		} as Env,
		exports,
		gatewayProps: createGatewayProps('usage-user-1'),
	}).execute('async () => "ok"', providers)

	expect(errorResult.error).toBe('boom')
	expect(dataPoints).toHaveLength(2)
	expect(dataPoints[1]?.blobs?.[3]).toBe('error')
	expect(rollupWrites).toHaveLength(0)

	// Loader throwing: error event recorded, original error rethrown.
	const throwingLoader = {
		get() {
			throw new Error('loader unavailable')
		},
	} as unknown as Env['LOADER']
	await expect(
		createExecuteExecutor({
			env: {
				...createExecutorTestEnv(throwingLoader),
				...usageBindings,
			} as Env,
			exports,
			gatewayProps: createGatewayProps('usage-user-1'),
		}).execute('async () => "ok"', providers),
	).rejects.toThrow('loader unavailable')
	expect(dataPoints).toHaveLength(3)
	expect(dataPoints[2]?.blobs?.[3]).toBe('error')

	// No signed-in user: nothing recorded.
	const anonymousLoader = createFakeWorkerLoader()
	await createExecuteExecutor({
		env: {
			...createExecutorTestEnv(anonymousLoader.loader),
			...usageBindings,
		} as Env,
		exports,
		gatewayProps: { ...createGatewayProps('usage-user-1'), userId: null },
	}).execute('async () => "ok"', providers)
	expect(dataPoints).toHaveLength(3)
	expect(rollupWrites).toHaveLength(0)

	// Provider validation failure never reaches the sandbox: nothing recorded.
	const validationLoader = createFakeWorkerLoader()
	const validationResult = await createExecuteExecutor({
		env: {
			...createExecutorTestEnv(validationLoader.loader),
			...usageBindings,
		} as Env,
		exports,
		gatewayProps: createGatewayProps('usage-user-1'),
	}).execute('async () => "ok"', [{ name: 'class', fns: {} }])
	expect(validationResult.error).toContain('reserved')
	expect(dataPoints).toHaveLength(3)
	expect(rollupWrites).toHaveLength(0)
})

test('createExecuteExecutor rejects reserved JavaScript provider names before loading a worker', async () => {
	const fakeLoader = createFakeWorkerLoader()
	for (const name of ['class', 'private']) {
		const result = await createExecuteExecutor({
			env: createExecutorTestEnv(fakeLoader.loader),
			exports: createExecutorTestExports(),
			gatewayProps: createGatewayProps('user-1'),
		}).execute('async () => "ok"', [
			{
				name,
				fns: {},
			},
		])

		expect(result).toEqual({
			result: undefined,
			error: `Provider name "${name}" is a JavaScript reserved word`,
		})
	}
	expect(fakeLoader.factoryCallCount).toBe(0)
})

test('createExecuteExecutor disables dispatchers after execution completes', async () => {
	const fakeLoader = createFakeWorkerLoader()
	await createExecuteExecutor({
		env: createExecutorTestEnv(fakeLoader.loader),
		exports: createExecutorTestExports(),
		gatewayProps: createGatewayProps('user-1'),
	}).execute('async () => await kody.search({ q: "ok" })', [
		{
			name: 'kody',
			fns: {
				search: async () => ({ ok: true }),
			},
		},
	])
	const dispatchers = fakeLoader.evaluations[0]
	const result = await dispatchers?.kody?.call('search', '{}')

	expect(JSON.parse(result ?? '{}')).toEqual({
		error: 'Execution has already completed.',
	})
})

test('createToolDispatchers rejects duplicate sanitized tool names', () => {
	expect(() =>
		createToolDispatchers(
			[
				{
					name: 'kody',
					fns: {
						'remote:home:set_pin': async () => ({ ok: true }),
						remotehomeset_pin: async () => ({ ok: false }),
					},
				},
			],
			{ active: true },
		),
	).toThrow(
		'Provider "kody" has tool names "remote:home:set_pin" and "remotehomeset_pin" that both sanitize to "remotehomeset_pin".',
	)
})

test('createToolDispatchers forwards rest args for codemode 0.4 ToolDispatcher', async () => {
	const dispatchers = createToolDispatchers(
		[
			{
				name: 'state',
				fns: {
					readFile: async (path: unknown) => path,
					merge: async (left: unknown, right: unknown) => [left, right],
					search: async (query: unknown) => query,
				},
			},
		],
		{ active: true },
	)

	await expect(
		JSON.parse(
			(await dispatchers.state.call(
				'readFile',
				JSON.stringify(['/tmp/foo']),
			)) ?? '{}',
		),
	).toEqual({ result: '/tmp/foo' })
	await expect(
		JSON.parse(
			(await dispatchers.state.call('merge', JSON.stringify(['a', 'b']))) ??
				'{}',
		),
	).toEqual({ result: ['a', 'b'] })
	await expect(
		JSON.parse(
			(await dispatchers.state.call('search', JSON.stringify([{ q: 'ok' }]))) ??
				'{}',
		),
	).toEqual({ result: { q: 'ok' } })
})

test('generated provider proxy uses rest args for sandbox tool calls', () => {
	const moduleSource = createExecutorModuleSource({
		code: 'async () => "ok"',
		providers: [
			{
				name: 'codemode',
				fns: {
					search: async () => ({ ok: true }),
				},
			},
		],
		shadowGlobalThis: false,
		timeoutMs: 1_000,
	})
	expect(moduleSource).toContain('async (...args) => {')
	expect(moduleSource).toContain('JSON.stringify(args)')
	expect(moduleSource).not.toContain('JSON.stringify(args ?? {})')
})

test('executor maps secret errors, formats guidance, extracts raw content, and truncates on UTF-8 boundaries', () => {
	const capabilityError = new Error(
		createCapabilitySecretAccessDeniedMessage(
			'cloudflareToken',
			'secret_set',
			'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
		),
	)
	expect(getExecutionErrorDetails(capabilityError)).toMatchObject({
		kind: 'secret_capability_access_required',
		secretNames: ['cloudflareToken'],
		capabilityName: 'secret_set',
		approvalUrl:
			'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
		nextStep:
			'Send the user the capability approval link so they can approve with one click in the account secrets UI, then retry after approval.',
		suggestedAction: {
			type: 'edit_secret_policy',
			policyField: 'allowed_capabilities',
		},
	})

	const capabilityErrorWithoutUrl = new Error(
		createCapabilitySecretAccessDeniedMessage('cloudflareToken', 'secret_set'),
	)
	expect(getExecutionErrorDetails(capabilityErrorWithoutUrl)).toMatchObject({
		kind: 'secret_capability_access_required',
		secretNames: ['cloudflareToken'],
		capabilityName: 'secret_set',
		approvalUrl: null,
		nextStep:
			"Ask the user whether this capability should be allowed to use the secret. If they approve, help them add this capability name to the secret's allowed capabilities in the account secrets UI, then retry.",
		suggestedAction: {
			type: 'edit_secret_policy',
			policyField: 'allowed_capabilities',
		},
	})

	const capabilityBatchError = new Error(
		createCapabilitySecretAccessDeniedBatchMessage([
			{
				secretName: 'lutronUsername',
				capabilityName: 'lighting_lutron_set_credentials',
				approvalUrl:
					'https://example.com/account/secrets/user/lutronUsername?capability=lighting_lutron_set_credentials',
			},
			{
				secretName: 'lutronPassword',
				capabilityName: 'lighting_lutron_set_credentials',
				approvalUrl:
					'https://example.com/account/secrets/user/lutronPassword?capability=lighting_lutron_set_credentials',
			},
		]),
	)
	expect(getExecutionErrorDetails(capabilityBatchError)).toMatchObject({
		kind: 'secret_capability_access_required_batch',
		missingApprovals: [
			{
				secretName: 'lutronUsername',
				capabilityName: 'lighting_lutron_set_credentials',
			},
			{
				secretName: 'lutronPassword',
				capabilityName: 'lighting_lutron_set_credentials',
			},
		],
		suggestedAction: {
			type: 'edit_secret_policy',
			policyField: 'allowed_capabilities',
		},
	})

	const hostBatchError = new Error(
		createHostSecretAccessDeniedBatchMessage([
			{
				secretName: 'cloudflareToken',
				host: 'api.cloudflare.com',
				approvalUrl:
					'https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com',
			},
			{
				secretName: 'slackToken',
				host: 'slack.com',
				approvalUrl:
					'https://example.com/account/secrets/user/slackToken?allowed-host=slack.com',
			},
		]),
	)
	expect(getExecutionErrorDetails(hostBatchError)).toMatchObject({
		kind: 'host_approval_required_batch',
		missingApprovals: [
			{
				secretName: 'cloudflareToken',
				host: 'api.cloudflare.com',
			},
			{
				secretName: 'slackToken',
				host: 'slack.com',
			},
		],
		suggestedAction: {
			type: 'approve_secret_host',
		},
	})

	const packageBatchError = new Error(
		createPackageSecretAccessDeniedBatchMessage(
			[
				{
					secretName: 'discordBotToken',
					packageId: 'pkg-1',
					kodyId: 'release',
					packageName: 'release',
					approvalUrl:
						'https://example.com/account/secrets/user/discordBotToken?package_id=pkg-1',
				},
				{
					secretName: 'xAccessToken',
					packageId: 'pkg-1',
					kodyId: 'release',
					packageName: 'release',
					approvalUrl:
						'https://example.com/account/secrets/user/xAccessToken?package_id=pkg-1',
				},
			],
			{
				bulkApprovalUrl:
					'https://example.com/account/secrets/approve?package_id=pkg-1&names=discordBotToken,xAccessToken',
			},
		),
	)
	expect(getExecutionErrorDetails(packageBatchError)).toMatchObject({
		kind: 'secret_package_access_required_batch',
		bulkApprovalUrl:
			'https://example.com/account/secrets/approve?package_id=pkg-1&names=discordBotToken,xAccessToken',
		missingApprovals: [
			{ secretName: 'discordBotToken', packageId: 'pkg-1' },
			{ secretName: 'xAccessToken', packageId: 'pkg-1' },
		],
		nextStep: expect.stringContaining('bulk package secret approval link'),
	})

	const entitlementError = new EntitlementLimitError({
		resource: 'saved_packages',
		plan: 'pro',
		limit: 3,
		current: 3,
		upgradeHint: 'Remove an old package or upgrade your plan.',
	})
	expect(getExecutionErrorDetails(entitlementError)).toMatchObject({
		kind: 'entitlement_limit_exceeded',
		details: {
			code: 'entitlement_limit_exceeded',
			resource: 'saved_packages',
			plan: 'pro',
			limit: 3,
			current: 3,
			upgradeHint: 'Remove an old package or upgrade your plan.',
		},
		suggestedAction: {
			type: 'review_plan_limit',
			resource: 'saved_packages',
		},
	})
	expect(
		getExecutionErrorDetails(new Error(entitlementError.message)),
	).toMatchObject({
		kind: 'entitlement_limit_exceeded',
		details: {
			code: 'entitlement_limit_exceeded',
			resource: 'saved_packages',
			plan: 'pro',
			limit: 3,
			current: 3,
			upgradeHint: 'Remove an old package or upgrade your plan.',
		},
	})

	// A bare ReferenceError for a kody:runtime export must point at the
	// missing import instead of leaving the caller to guess.
	expect(
		getExecutionErrorDetails(new Error('kody is not defined')),
	).toMatchObject({
		kind: 'runtime_import_missing',
		exportName: 'kody',
		nextStep: expect.stringContaining("import { kody } from 'kody:runtime'"),
		suggestedAction: { type: 'fix_code' },
	})
	expect(
		getExecutionErrorDetails(
			new Error('ReferenceError: secretHeaders is not defined'),
		),
	).toMatchObject({
		kind: 'runtime_import_missing',
		exportName: 'secretHeaders',
	})
	// Unknown identifiers stay unhinted: they are ordinary user-code bugs.
	expect(
		getExecutionErrorDetails(new Error('myHelper is not defined')),
	).toBeNull()

	// A guard-less access to an imported-but-unbound optional kody:runtime
	// helper must name the helper and the realistic remedies instead of
	// leaving the bare TypeError.
	const unboundStorageMessage = createUnboundRuntimeHelperMessage({
		originalMessage: "Cannot read properties of undefined (reading 'sql')",
		helperName: 'storage',
		reference: 'storage.sql',
	})
	expect(
		getExecutionErrorDetails(new Error(unboundStorageMessage)),
	).toMatchObject({
		kind: 'runtime_helper_unbound',
		helperName: 'storage',
		nextStep: expect.stringContaining('`storageId`'),
		suggestedAction: { type: 'fix_code' },
	})
	expect(
		getExecutionErrorDetails(new Error(unboundStorageMessage))?.nextStep,
	).toContain('packages.invokeChecked')
	// Saved-package code should always use packageStorage() (the storage
	// prescription), so the hint leads with it before the storageId and
	// invokeChecked alternatives.
	const unboundStorageNextStep =
		getExecutionErrorDetails(new Error(unboundStorageMessage))?.nextStep ?? ''
	expect(unboundStorageNextStep).toContain('packageStorage()')
	expect(unboundStorageNextStep.indexOf('packageStorage()')).toBeLessThan(
		unboundStorageNextStep.indexOf('`storageId`'),
	)
	expect(unboundStorageNextStep.indexOf('packageStorage()')).toBeLessThan(
		unboundStorageNextStep.indexOf('packages.invokeChecked'),
	)
	// Wrapped transports prefix the message (for example package invocation
	// responses); parsing stays prefix-tolerant.
	expect(
		getExecutionErrorDetails(
			new Error(`[execution_failed] ${unboundStorageMessage}`),
		),
	).toMatchObject({
		kind: 'runtime_helper_unbound',
		helperName: 'storage',
	})
	// Helpers without a dedicated remedy get the generic guard guidance.
	expect(
		getExecutionErrorDetails(
			new Error(
				createUnboundRuntimeHelperMessage({
					originalMessage:
						"Cannot read properties of undefined (reading 'basic')",
					helperName: 'secretHeaders',
					reference: 'secretHeaders.basic',
				}),
			),
		),
	).toMatchObject({
		kind: 'runtime_helper_unbound',
		helperName: 'secretHeaders',
		nextStep: expect.stringContaining('if (secretHeaders) { ... }'),
	})
	// The bare TypeError alone stays unhinted: without the rewrite marker the
	// undefined value may be any user-code bug.
	expect(
		getExecutionErrorDetails(
			new Error("Cannot read properties of undefined (reading 'sql')"),
		),
	).toBeNull()

	// A disposed RPC stub in the sandbox means per-run state leaked into a
	// cached dynamic worker; the structured hint explains how to escape the
	// poisoned worker instead of suggesting a futile identical retry.
	expect(
		getExecutionErrorDetails(new Error('RPC stub used after being disposed.')),
	).toMatchObject({
		kind: 'sandbox_runtime_stale',
		nextStep: expect.stringContaining('fresh sandbox'),
		suggestedAction: { type: 'report_bug' },
	})

	expect(
		getExecutionErrorDetails(new Error('Too many concurrent dynamic workers')),
	).toMatchObject({
		kind: 'dynamic_worker_capacity_exceeded',
		limit: 4,
		nextStep: expect.stringContaining('Retry'),
		suggestedAction: { type: 'retry' },
	})
	expect(
		getExecutionErrorDetails(
			new Error(
				'[invocation_failed] Dynamic worker concurrency limit exceeded: each request may have up to 4 concurrent dynamic worker invocations. Wait for one to finish before starting another.',
			),
		),
	).toMatchObject({
		kind: 'dynamic_worker_capacity_exceeded',
		limit: 4,
		suggestedAction: { type: 'retry' },
	})
	expect(
		getExecutionErrorDetails(
			new Error('Too many concurrent dynamic worker requests'),
		),
	).toBeNull()

	const storageEstimateError = createStorageEstimateReadError({
		storageId: 'package:unreadable',
		attempts: 3,
		cause: new Error('RPC disconnected'),
	})
	expect(
		getExecutionErrorDetails(
			new Error('Nested execute failed.', {
				cause: new Error(`[execution_failed] ${storageEstimateError.message}`),
			}),
		),
	).toMatchObject({
		kind: 'storage_estimate_unavailable',
		storageId: 'package:unreadable',
		attempts: 3,
		nextStep: expect.stringContaining('safely blocked'),
		suggestedAction: { type: 'retry' },
	})

	const errors = [
		capabilityError,
		new Error(createMissingSecretMessage('missingToken')),
		new Error('kody is not defined'),
		new Error(unboundStorageMessage),
	]
	for (const error of errors) {
		const output = formatExecutionOutput({ error } as const)
		const plainOutput = `Error: ${error.message}`
		expect(output).toContain(plainOutput)
		expect(output.length).toBeGreaterThan(plainOutput.length)
	}

	const content: Array<ContentBlock> = [
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
	expect(
		extractRawContent({
			__mcpContent: content,
		}),
	).toEqual(content)
	expect(extractRawContent({ result: 'not raw content' })).toBeNull()
	expect(
		extractRawContent({
			content: [
				{
					type: 'image',
					data: 'AAAA',
					mimeType: 'image/png',
				},
			],
		}),
	).toBeNull()

	const oneByteLimit = limitExecutionResultValue('éabc', 1)
	expect(oneByteLimit).toMatchObject({
		value: '',
		returnedBytes: 5,
		truncated: true,
	})

	const threeByteLimit = limitExecutionResultValue('éabc', 3)
	expect(threeByteLimit).toMatchObject({
		value: 'éa',
		returnedBytes: 5,
		truncated: true,
	})
	expect(
		new TextEncoder().encode(String(threeByteLimit.value)).byteLength,
	).toBe(3)
})

test('limitExecutionResultValue preserves output for representative small and oversized values', () => {
	const smallObject = { ok: true, count: 3 }
	const smallObjectLimited = limitExecutionResultValue(smallObject, 102_400)
	expect(smallObjectLimited).toMatchObject({
		value: smallObject,
		returnedBytes: 21,
		truncated: false,
	})
	expect(smallObjectLimited.displayText).toBe(
		JSON.stringify(smallObject, null, 2),
	)
	expect(
		formatLimitedExecutionOutput({
			value: smallObjectLimited.value,
			truncated: smallObjectLimited.truncated,
			displayText: smallObjectLimited.displayText,
		}),
	).toBe(smallObjectLimited.displayText)

	const oversizedObject = {
		rows: [{ id: 'message-1', payload: 'abcdef' }],
	}
	const oversizedObjectLimited = limitExecutionResultValue(oversizedObject, 10)
	expect(oversizedObjectLimited).toMatchObject({
		value: {
			truncated: true,
			type: 'object',
		},
		returnedBytes: 48,
		truncated: true,
		note: 'Returned value was 48 bytes, exceeding responseLimit 10 bytes; output was truncated. Project fields before returning.',
	})
	expect(
		formatLimitedExecutionOutput({
			value: oversizedObjectLimited.value,
			truncated: oversizedObjectLimited.truncated,
			note: oversizedObjectLimited.note,
			displayText: oversizedObjectLimited.displayText,
		}),
	).toBe(
		`${oversizedObjectLimited.displayText}\n\n--- TRUNCATED ---\n${oversizedObjectLimited.note}`,
	)

	const oversizedStringLimited = limitExecutionResultValue('hello world', 5)
	expect(oversizedStringLimited).toMatchObject({
		value: 'hello',
		returnedBytes: 11,
		truncated: true,
	})
	expect(oversizedStringLimited.displayText).toBeUndefined()
	expect(
		formatLimitedExecutionOutput({
			value: oversizedStringLimited.value,
			truncated: oversizedStringLimited.truncated,
			note: oversizedStringLimited.note,
		}),
	).toBe(`hello\n\n--- TRUNCATED ---\n${oversizedStringLimited.note}`)
})
