import { expect, test } from 'vitest'
import { type StorageContext } from '#mcp/storage.ts'
import { createExecuteExecutor } from './executor.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { countEvaluateInvocationParamsChars } from '#worker/usage/dynamic-worker-invoke.ts'
import { usageEventDoubleIndexes } from '#worker/usage/record-usage.ts'

type FakeWorkerOptions = Record<string, unknown>

function createFakeWorkerLoader() {
	const createdOptions = new Map<string, FakeWorkerOptions>()
	const loader = {
		get(id: string, factory: () => FakeWorkerOptions) {
			let options = createdOptions.get(id)
			if (!options) {
				options = factory()
				createdOptions.set(id, options)
			}
			return {
				getEntrypoint() {
					return {
						async evaluate() {
							return { result: id, logs: [] }
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	return { loader }
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

function createGatewayProps(
	userId: string,
	overrides?: {
		email?: string | null
		storageContext?: StorageContext | null
	},
) {
	return {
		baseUrl: 'https://heykody.dev',
		userId,
		email: overrides?.email ?? `${userId}@example.com`,
		storageContext:
			overrides?.storageContext === undefined ? null : overrides.storageContext,
	}
}

test('createExecuteExecutor records privacy-safe Dynamic Worker reuse on every LOADER invoke', async () => {
	const dataPoints: Array<AnalyticsEngineDataPoint> = []
	const meter = createInMemoryUserMeterEnv()
	const usageBindings = {
		...meter.env,
		USAGE_EVENTS: {
			writeDataPoint(point?: AnalyticsEngineDataPoint) {
				if (point) dataPoints.push(point)
			},
		},
	}
	const exports = createExecutorTestExports()
	const providers = [{ name: 'kody', fns: {} }]
	const sourceMarker = 'UNIQUE_SOURCE_MARKER_reuse_metrics'
	const paramMarker = 'UNIQUE_PARAM_MARKER_reuse_metrics'
	const source = `async () => "${sourceMarker}"`

	const firstLoader = createFakeWorkerLoader()
	await createExecuteExecutor({
		env: {
			...createExecutorTestEnv(firstLoader.loader),
			...usageBindings,
		} as Env,
		exports,
		gatewayProps: createGatewayProps('usage-user-reuse'),
		recordExecuteUsage: false,
		surface: 'job',
		executeShape: 'glue',
	}).execute(source, providers, {
		params: { token: paramMarker },
	})

	const miss = dataPoints.find(
		(point) => point.blobs?.[1] === 'dynamic_worker_invoke',
	)
	expect(miss?.blobs?.[5]).toBe('job')
	expect(miss?.blobs?.[6]).toBe('glue')
	expect(miss?.blobs?.[7]).toBe('miss')
	expect(miss?.blobs?.[8]).toBe('true')
	expect(miss?.doubles?.[0]).toBeGreaterThanOrEqual(0)
	expect(miss?.doubles?.[3]).toBeGreaterThan(0)
	expect(miss?.doubles?.[usageEventDoubleIndexes.paramsChars]).toBe(
		countEvaluateInvocationParamsChars({ token: paramMarker }),
	)
	const missCodeChars = miss?.doubles?.[3] ?? 0

	const secondLoader = createFakeWorkerLoader()
	await createExecuteExecutor({
		env: {
			...createExecutorTestEnv(secondLoader.loader),
			...usageBindings,
		} as Env,
		exports,
		gatewayProps: createGatewayProps('usage-user-reuse'),
		recordExecuteUsage: false,
		surface: 'job',
		executeShape: 'glue',
	}).execute(source, providers, {
		params: { token: `${paramMarker}-2` },
	})

	const invokes = dataPoints.filter(
		(point) => point.blobs?.[1] === 'dynamic_worker_invoke',
	)
	expect(invokes).toHaveLength(2)
	expect(invokes[1]?.blobs?.[7]).toBe('hit')
	expect(invokes[1]?.blobs?.[8]).toBe('true')
	expect(invokes[1]?.doubles?.[3]).toBe(missCodeChars)
	expect(invokes[1]?.doubles?.[usageEventDoubleIndexes.paramsChars]).toBe(
		countEvaluateInvocationParamsChars({ token: `${paramMarker}-2` }),
	)

	const emptyParamsCases: Array<unknown> = [
		undefined,
		{},
		null,
		'not-an-object',
	]
	for (const params of emptyParamsCases) {
		const loader = createFakeWorkerLoader()
		await createExecuteExecutor({
			env: {
				...createExecutorTestEnv(loader.loader),
				...usageBindings,
			} as Env,
			exports,
			gatewayProps: createGatewayProps('usage-user-reuse'),
			recordExecuteUsage: false,
			surface: 'job',
		}).execute(source, providers, params === undefined ? undefined : { params })
		expect(dataPoints.at(-1)?.blobs?.[1]).toBe('dynamic_worker_invoke')
		expect(dataPoints.at(-1)?.blobs?.[8]).toBe('false')
		expect(
			dataPoints.at(-1)?.doubles?.[usageEventDoubleIndexes.paramsChars],
		).toBe(0)
	}

	expect(
		dataPoints.filter((point) => point.blobs?.[1] === 'dynamic_worker_invoke'),
	).toHaveLength(6)

	const serialized = JSON.stringify(dataPoints)
	expect(serialized).not.toContain(sourceMarker)
	expect(serialized).not.toContain(paramMarker)
	expect(serialized).not.toContain(source)
	expect(serialized).not.toContain('token')
	expect(serialized).not.toContain('not-an-object')
})
