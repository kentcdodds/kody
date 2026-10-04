import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	evaluateUnitJobBudget,
	main,
	parseNxCacheStatus,
	unitJobBudgets,
} from './enforce-unit-job-budget.ts'

test('unit job budgets fail warm overruns and ignore Nx cache misses', () => {
	const previousExitCode = process.exitCode
	const workflow = readFileSync(
		new URL('../../.github/workflows/validate.yml', import.meta.url),
		'utf8',
	)
	const logDir = mkdtempSync(join(tmpdir(), 'unit-job-budget-'))

	expect(unitJobBudgets.node.maxSeconds).toBe(60)
	expect(unitJobBudgets.workers.maxSeconds).toBe(90)
	expect(unitJobBudgets.node.jobName).toBe('🧪 Node')
	expect(unitJobBudgets.workers.jobName).toBe('☁️ Workers')

	expect(parseNxCacheStatus('Cache: 1/1 hit (100%)')).toBe('hit')
	expect(parseNxCacheStatus('Cache:             0/1 hit (0%)')).toBe('miss')
	expect(parseNxCacheStatus('no cache line here')).toBe('unknown')

	expect(
		evaluateUnitJobBudget({
			leg: 'node',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 45,
			nxCacheStatus: 'hit',
		}).ok,
	).toBe(true)
	expect(
		evaluateUnitJobBudget({
			leg: 'node',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 61,
			nxCacheStatus: 'hit',
		}).ok,
	).toBe(false)
	expect(
		evaluateUnitJobBudget({
			leg: 'node',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 321,
			nxCacheStatus: 'miss',
		}).ok,
	).toBe(true)
	expect(
		evaluateUnitJobBudget({
			leg: 'workers',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 282,
			nxCacheStatus: 'unknown',
		}).ok,
	).toBe(true)
	expect(
		evaluateUnitJobBudget({
			leg: 'workers',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 91,
			nxCacheStatus: 'hit',
		}).ok,
	).toBe(false)

	expect(workflow).toContain(
		'node tools/ci/enforce-unit-job-budget.ts --leg node --start-epoch',
	)
	expect(workflow).toContain(
		'node tools/ci/enforce-unit-job-budget.ts --leg workers --start-epoch',
	)
	expect(workflow).toContain('UNIT_JOB_START_EPOCH')
	expect(workflow).toContain('--nx-log unit-job-nx.log')
	expect(workflow).toContain('tee unit-job-nx.log')

	const hitLog = join(logDir, 'hit.log')
	writeFileSync(
		hitLog,
		['Nx stuff', '  Cache:             1/1 hit (100%)', ''].join('\n'),
	)
	process.exitCode = undefined
	main([
		'--leg',
		'node',
		'--start-epoch',
		String(Math.floor(Date.now() / 1000) - 10),
		'--nx-log',
		hitLog,
	])
	expect(process.exitCode).toBe(0)

	const missLog = join(logDir, 'miss.log')
	writeFileSync(missLog, 'Cache: 0/1 hit (0%)\n')
	process.exitCode = undefined
	main([
		'--leg',
		'node',
		'--start-epoch',
		String(Math.floor(Date.now() / 1000) - 120),
		'--nx-log',
		missLog,
	])
	expect(process.exitCode).toBe(0)

	consoleError.mockImplementation(() => {})
	process.exitCode = undefined
	main([])
	expect(process.exitCode).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		'Usage: node tools/ci/enforce-unit-job-budget.ts --leg <node|workers> --start-epoch <unix-seconds> --nx-log <path>',
	)

	process.exitCode = previousExitCode
})
