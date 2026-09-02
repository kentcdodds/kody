import { expect, test } from 'vitest'
import { runQueueableDynamicWorkerWork } from '#worker/dynamic-worker-evaluation-budget.ts'
import {
	createExecuteExecutor,
	createToolDispatchers,
	runWithDynamicWorkerEvaluationBudget,
} from './executor.ts'

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
		storageContext: null,
	}
}

test('createExecuteExecutor fails fast when a request saturates its four-evaluation budget', async () => {
	const concurrencyLimitMessage =
		'Dynamic worker concurrency limit exceeded: each request may have up to 4 concurrent dynamic worker invocations.'
	const exports = createExecutorTestExports()
	const providers = [{ name: 'kody', fns: {} }]

	{
		let evaluationCount = 0
		let maxActiveEvaluations = 0
		let activeEvaluations = 0
		let releaseChildren: () => void = () => {}
		const childrenMayFinish = new Promise<void>((resolve) => {
			releaseChildren = resolve
		})
		let nestedEnv: Env
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

		await expect(
			createExecuteExecutor({
				env: nestedEnv,
				exports,
				gatewayProps: createGatewayProps('nested-user'),
			}).execute('async () => "root"', providers),
		).rejects.toThrow(concurrencyLimitMessage)
		releaseChildren()
		expect(evaluationCount).toBe(4)
		expect(maxActiveEvaluations).toBe(4)
	}

	{
		let evaluationCount = 0
		let recursiveEnv: Env
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
		).rejects.toThrow(concurrencyLimitMessage)
		expect(Date.now() - startedAtMs).toBeLessThan(1_000)
		expect(evaluationCount).toBe(4)
	}

	{
		let evaluationCount = 0
		let childCount = 0
		let releaseChildren: () => void = () => {}
		const allChildrenStarted = new Promise<void>((resolve) => {
			releaseChildren = resolve
		})
		let recursiveEnv: Env
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
		).rejects.toThrow(concurrencyLimitMessage)
		expect(Date.now() - startedAtMs).toBeLessThan(1_000)
		expect(evaluationCount).toBe(4)
	}
})

test('queueable subscription-style work waits instead of fail-fast under a parent evaluate', async () => {
	const exports = createExecutorTestExports()
	const providers = [{ name: 'kody', fns: {} }]
	let evaluationCount = 0
	let maxActiveEvaluations = 0
	let activeEvaluations = 0
	const releases: Array<() => void> = []
	let nestedEnv: Env
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
								const children = runQueueableDynamicWorkerWork(async () =>
									Promise.all(
										Array.from({ length: 5 }, async (_, index) => {
											return await createExecuteExecutor({
												env: nestedEnv,
												exports,
												gatewayProps: createGatewayProps('queueable-user'),
											}).execute(`async () => ${index}`, providers)
										}),
									),
								)
								const result = await children
								activeEvaluations -= 1
								return { result, logs: [] }
							}
							await new Promise<void>((resolve) => {
								releases.push(() => {
									activeEvaluations -= 1
									resolve()
								})
							})
							return { result: 'child', logs: [] }
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	nestedEnv = createExecutorTestEnv(loader)

	const parent = createExecuteExecutor({
		env: nestedEnv,
		exports,
		gatewayProps: createGatewayProps('queueable-user'),
	}).execute('async () => "root"', providers)

	await expect.poll(() => evaluationCount).toBe(4)
	expect(maxActiveEvaluations).toBe(4)
	while (evaluationCount < 6) {
		await expect.poll(() => releases.length).toBeGreaterThan(0)
		releases.shift()?.()
	}
	for (const release of releases.splice(0)) release()
	await parent
	expect(evaluationCount).toBe(6)
	expect(maxActiveEvaluations).toBe(4)
	expect(activeEvaluations).toBe(0)
})

test('createToolDispatchers restores the captured budget after an ALS gap', async () => {
	const exports = createExecutorTestExports()
	const providers = [{ name: 'kody', fns: {} }]
	const state = {
		started: 0,
		active: 0,
		maxActive: 0,
		releases: [] as Array<() => void>,
	}
	const loader = {
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
	} as unknown as Env['LOADER']
	const env = createExecutorTestEnv(loader)
	let dispatchers: ReturnType<typeof createToolDispatchers> | undefined
	await runWithDynamicWorkerEvaluationBudget(async () => {
		dispatchers = createToolDispatchers(
			[
				{
					name: 'kody',
					fns: {
						fanOut: async () =>
							await Promise.all(
								Array.from({ length: 5 }, async (_, index) => {
									return await createExecuteExecutor({
										env,
										exports,
										gatewayProps: createGatewayProps('rpc-user'),
									}).execute(`async () => ${index}`, providers)
								}),
							),
					},
				},
			],
			{ active: true },
		)
	})

	const fanOut = dispatchers?.kody.call('fanOut', '[]')
	await expect.poll(() => state.started).toBe(4)
	expect(state.maxActive).toBe(4)
	state.releases.shift()?.()
	await expect.poll(() => state.started).toBe(5)
	for (const release of state.releases.splice(0)) release()
	await fanOut
	expect(state.started).toBe(5)
	expect(state.maxActive).toBe(4)
	expect(state.active).toBe(0)
})
