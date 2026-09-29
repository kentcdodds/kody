import { expect, test } from 'vitest'
import { runQueueableDynamicWorkerWork } from '#worker/dynamic-worker-evaluation-budget.ts'
import {
	createExecuteExecutor,
	createToolDispatchers,
	runWithDynamicWorkerEvaluationBudget,
} from './executor.ts'

const concurrencyLimitMessage =
	'Dynamic worker concurrency limit exceeded: each request may have up to 4 concurrent dynamic worker invocations.'
const exports = {
	KodyFetchGateway: ({ props }: { props: unknown }) => ({ props }),
} as never
const providers = [{ name: 'kody', fns: {} }]

function createLoaderEnv(evaluate: (serializedOptions: string) => unknown) {
	const loader = {
		get(_id: string, factory: () => Record<string, unknown>) {
			const serializedOptions = JSON.stringify(factory())
			return {
				getEntrypoint() {
					return { evaluate: async () => await evaluate(serializedOptions) }
				},
			}
		},
	} as unknown as Env['LOADER']
	return { LOADER: loader, APP_COMMIT_SHA: 'commit-for-test' } as Env
}

function executeAs(env: Env, userId: string, code: string) {
	return createExecuteExecutor({
		env,
		exports,
		gatewayProps: {
			baseUrl: 'https://heykody.dev',
			userId,
			email: null,
			storageContext: null,
		},
	}).execute(code, providers)
}

function fanOut(env: Env, userId: string, count: number) {
	return Promise.all(
		Array.from({ length: count }, (_, index) =>
			executeAs(env, userId, `async () => ${index}`),
		),
	)
}

function createActiveCounter() {
	const state = { started: 0, active: 0, maxActive: 0 }
	return {
		state,
		start() {
			state.started += 1
			state.active += 1
			state.maxActive = Math.max(state.maxActive, state.active)
		},
	}
}

test('createExecuteExecutor fails fast when a request saturates its four-evaluation budget', async () => {
	{
		const counter = createActiveCounter()
		let releaseChildren: () => void = () => {}
		const childrenMayFinish = new Promise<void>((resolve) => {
			releaseChildren = resolve
		})
		const env: Env = createLoaderEnv(async () => {
			counter.start()
			if (counter.state.started === 1)
				return await fanOut(env, 'nested-user', 5)
			await childrenMayFinish
			counter.state.active -= 1
			return { result: 'child', logs: [] }
		})

		await expect(
			executeAs(env, 'nested-user', 'async () => "root"'),
		).rejects.toThrow(concurrencyLimitMessage)
		releaseChildren()
		expect(counter.state).toMatchObject({ started: 4, maxActive: 4 })
	}

	{
		let evaluationCount = 0
		const env: Env = createLoaderEnv(async () => {
			evaluationCount += 1
			return await executeAs(
				env,
				'recursive-user',
				`async () => ${evaluationCount}`,
			)
		})

		const startedAtMs = Date.now()
		await expect(
			executeAs(env, 'recursive-user', 'async () => "root"'),
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
		const env: Env = createLoaderEnv(async (serializedOptions) => {
			evaluationCount += 1
			if (serializedOptions.includes('root-marker')) {
				return await Promise.all(
					Array.from({ length: 3 }, (_, index) =>
						executeAs(env, 'mixed-user', `async () => "child-marker-${index}"`),
					),
				)
			}
			if (serializedOptions.includes('child-marker')) {
				childCount += 1
				if (childCount === 3) releaseChildren()
				await allChildrenStarted
				return await executeAs(
					env,
					'mixed-user',
					'async () => "descendant-marker"',
				)
			}
			return { result: 'descendant', logs: [] }
		})

		const startedAtMs = Date.now()
		await expect(
			executeAs(env, 'mixed-user', 'async () => "root-marker"'),
		).rejects.toThrow(concurrencyLimitMessage)
		expect(Date.now() - startedAtMs).toBeLessThan(1_000)
		expect(evaluationCount).toBe(4)
	}
})

test('queueable subscription-style work waits instead of fail-fast under a parent evaluate', async () => {
	const counter = createActiveCounter()
	const releases: Array<() => void> = []
	const env: Env = createLoaderEnv(async () => {
		counter.start()
		if (counter.state.started === 1) {
			const result = await runQueueableDynamicWorkerWork(async () =>
				fanOut(env, 'queueable-user', 5),
			)
			counter.state.active -= 1
			return { result, logs: [] }
		}
		await new Promise<void>((resolve) => {
			releases.push(() => {
				counter.state.active -= 1
				resolve()
			})
		})
		return { result: 'child', logs: [] }
	})

	const parent = executeAs(env, 'queueable-user', 'async () => "root"')

	await expect.poll(() => counter.state.started).toBe(4)
	expect(counter.state.maxActive).toBe(4)
	while (counter.state.started < 6) {
		await expect.poll(() => releases.length).toBeGreaterThan(0)
		releases.shift()?.()
	}
	for (const release of releases.splice(0)) release()
	await parent
	expect(counter.state).toEqual({ started: 6, active: 0, maxActive: 4 })
})

test('createToolDispatchers restores the captured budget after an ALS gap', async () => {
	const counter = createActiveCounter()
	const releases: Array<() => void> = []
	const env = createLoaderEnv(async () => {
		counter.start()
		await new Promise<void>((resolve) => {
			releases.push(() => {
				counter.state.active -= 1
				resolve()
			})
		})
		return { result: 'done', logs: [] }
	})
	let dispatchers: ReturnType<typeof createToolDispatchers> | undefined
	await runWithDynamicWorkerEvaluationBudget(async () => {
		dispatchers = createToolDispatchers(
			[
				{
					name: 'kody',
					fns: { fanOut: async () => fanOut(env, 'rpc-user', 5) },
				},
			],
			{ active: true },
		)
	})

	const kodyDispatcher = dispatchers?.kody
	if (!kodyDispatcher) throw new Error('Expected kody dispatcher')
	const fanOutCall = kodyDispatcher.call('fanOut', '[]')
	await expect.poll(() => counter.state.started).toBe(4)
	expect(counter.state.maxActive).toBe(4)
	releases.shift()?.()
	await expect.poll(() => counter.state.started).toBe(5)
	for (const release of releases.splice(0)) release()
	await fanOutCall
	expect(counter.state).toEqual({ started: 5, active: 0, maxActive: 4 })
})
