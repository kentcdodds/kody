import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	evaluateUnitJobBudget,
	main,
	unitJobBudgets,
} from './enforce-unit-job-budget.ts'

test('unit job budgets fail any overrun of the cold-run caps', () => {
	const previousExitCode = process.exitCode
	const workflow = readFileSync(
		new URL('../../.github/workflows/validate.yml', import.meta.url),
		'utf8',
	)

	expect(unitJobBudgets.node.maxSeconds).toBe(360)
	expect(unitJobBudgets.workers.maxSeconds).toBe(300)
	expect(unitJobBudgets.node.jobName).toBe('🧪 Node')
	expect(unitJobBudgets.workers.jobName).toBe('☁️ Workers')

	expect(
		evaluateUnitJobBudget({
			leg: 'node',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 359,
		}).ok,
	).toBe(true)
	expect(
		evaluateUnitJobBudget({
			leg: 'node',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 361,
		}).ok,
	).toBe(false)
	expect(
		evaluateUnitJobBudget({
			leg: 'workers',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 300,
		}).ok,
	).toBe(true)
	expect(
		evaluateUnitJobBudget({
			leg: 'workers',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 301,
		}).ok,
	).toBe(false)

	expect(workflow).toContain(
		'node tools/ci/enforce-unit-job-budget.ts --leg node --start-epoch',
	)
	expect(workflow).toContain(
		'node tools/ci/enforce-unit-job-budget.ts --leg workers --start-epoch',
	)
	expect(workflow).toContain('UNIT_JOB_START_EPOCH')
	expect(workflow).not.toContain('--nx-log')
	expect(workflow).not.toContain('tee unit-job-nx.log')
	expect(workflow).toContain('≤360s')
	expect(workflow).toContain('≤300s')

	process.exitCode = undefined
	main([
		'--leg',
		'node',
		'--start-epoch',
		String(Math.floor(Date.now() / 1000) - 10),
	])
	expect(process.exitCode).toBe(0)

	consoleError.mockImplementation(() => {})
	process.exitCode = undefined
	main([
		'--leg',
		'workers',
		'--start-epoch',
		String(Math.floor(Date.now() / 1000) - 301),
	])
	expect(process.exitCode).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('☁️ Workers took'),
	)

	consoleError.mockClear()
	process.exitCode = undefined
	main([])
	expect(process.exitCode).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		'Usage: node tools/ci/enforce-unit-job-budget.ts --leg <node|workers> --start-epoch <unix-seconds>',
	)

	process.exitCode = previousExitCode
})
