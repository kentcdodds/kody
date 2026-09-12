import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	countDynamicWorkerModuleGraphChars,
	evaluateInvocationHadParams,
	recordDynamicWorkerInvoke,
} from './dynamic-worker-invoke.ts'

test('evaluateInvocationHadParams is true only for a non-empty own-property object', () => {
	expect(evaluateInvocationHadParams({ token: 'x' })).toBe(true)
	expect(evaluateInvocationHadParams({ nested: { n: 1 } })).toBe(true)

	expect(evaluateInvocationHadParams({})).toBe(false)
	expect(evaluateInvocationHadParams(null)).toBe(false)
	expect(evaluateInvocationHadParams(undefined)).toBe(false)
	expect(evaluateInvocationHadParams([])).toBe(false)
	expect(evaluateInvocationHadParams(1)).toBe(false)
	expect(evaluateInvocationHadParams('params')).toBe(false)
	expect(evaluateInvocationHadParams(true)).toBe(false)
	expect(evaluateInvocationHadParams(Object.create({ inherited: 1 }))).toBe(
		false,
	)
})

test('countDynamicWorkerModuleGraphChars sums text only and ignores names', () => {
	expect(
		countDynamicWorkerModuleGraphChars({
			'secret-package.js': 'abcd',
			'harness.js': { js: 'ef', cjs: 'gh', text: 'ij' },
			'binary.wasm': { data: new ArrayBuffer(32) },
			'config.json': { json: { token: 'nope' } },
		}),
	).toBe(10)
})

test('recordDynamicWorkerInvoke writes numbers and closed enums only', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)

	await recordDynamicWorkerInvoke({
		env: {},
		userId: 'user-1',
		durationMs: 15,
		outcome: 'success',
		surface: 'execute',
		cacheReuse: 'miss',
		codeChars: 40,
		executeShape: 'thin_few_exports',
		hadParams: true,
	})

	expect(recordUsageSpy).toHaveBeenCalledTimes(1)
	expect(recordUsageSpy.mock.calls[0]?.[1]).toEqual({
		userId: 'user-1',
		eventType: 'dynamic_worker_invoke',
		durationMs: 15,
		outcome: 'success',
		surface: 'execute',
		cacheReuse: 'miss',
		codeChars: 40,
		hadParams: true,
		executeShape: 'thin_few_exports',
	})
	recordUsageSpy.mockRestore()
})

test('recordDynamicWorkerInvoke skips anonymous runs and never throws', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const spy = vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	consoleWarn.mockImplementation(() => {})

	await recordDynamicWorkerInvoke({
		env: {},
		userId: null,
		durationMs: 1,
		outcome: 'success',
		surface: 'job',
		cacheReuse: 'hit',
		codeChars: 1,
	})
	spy.mockRejectedValueOnce(new Error('usage exploded'))
	await recordDynamicWorkerInvoke({
		env: {},
		userId: 'user-1',
		durationMs: 1,
		outcome: 'error',
		surface: 'job',
		cacheReuse: 'hit',
		codeChars: 1,
	})

	expect(spy).toHaveBeenCalledTimes(1)
	expect(consoleWarn).toHaveBeenCalledWith(
		'dynamic-worker-invoke-record-failed',
		expect.any(Error),
	)
	spy.mockRestore()
})
