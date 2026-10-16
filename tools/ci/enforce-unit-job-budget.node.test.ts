import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	evaluateUnitJobBudget,
	getUnitJobMaxSeconds,
	isRetryableUnitJobAttemptExit,
	main,
	unitJobAttemptKillAfterExitCode,
	unitJobAttemptTimeoutExitCode,
} from './enforce-unit-job-budget.ts'

test('unit job budgets fail any overrun of the cold-run caps', () => {
	const previousExitCode = process.exitCode
	const workflow = readFileSync(
		new URL('../../.github/workflows/validate.yml', import.meta.url),
		'utf8',
	)

	expect(getUnitJobMaxSeconds('node')).toBe(720)
	expect(getUnitJobMaxSeconds('workers')).toBe(720)
	expect(isRetryableUnitJobAttemptExit(unitJobAttemptTimeoutExitCode)).toBe(
		true,
	)
	expect(isRetryableUnitJobAttemptExit(unitJobAttemptKillAfterExitCode)).toBe(
		true,
	)
	expect(isRetryableUnitJobAttemptExit(1)).toBe(false)
	expect(isRetryableUnitJobAttemptExit(0)).toBe(false)

	expect(
		evaluateUnitJobBudget({
			leg: 'node',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 720,
		}).ok,
	).toBe(true)
	expect(
		evaluateUnitJobBudget({
			leg: 'node',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 721,
		}).ok,
	).toBe(false)
	expect(
		evaluateUnitJobBudget({
			leg: 'workers',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 720,
		}).ok,
	).toBe(true)
	expect(
		evaluateUnitJobBudget({
			leg: 'workers',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 721,
		}).ok,
	).toBe(false)

	expect(workflow).toContain(
		'node tools/ci/enforce-unit-job-budget.ts --leg node --start-epoch',
	)
	expect(workflow).toContain(
		'node tools/ci/enforce-unit-job-budget.ts --leg workers --start-epoch',
	)
	expect(workflow).toContain('UNIT_JOB_START_EPOCH')
	// Workers retries once on soft-budget timeout (exit 124) or kill-after
	// (exit 137), not on assertion failures (#3763). Keep ADR 0011 isolation
	// intact. Retry status is captured under bash -e via if/else.
	expect(workflow).toContain('attempt_budget_seconds=720')
	expect(workflow).toContain('[ "$status" -ne 124 ] && [ "$status" -ne 137 ]')
	expect(workflow).toContain('[ "$status" -eq 124 ] || [ "$status" -eq 137 ]')
	expect(workflow).toContain('retrying once (#3763)')
	expect(workflow).toContain('npm run test:workers')
	expect(workflow).toContain(
		'if timeout --signal=TERM --kill-after=60s "${attempt_budget_seconds}s"',
	)
	// ADR 0011: retry must not disable per-file isolation or skip verify.
	const workersUnitStep = workflow.match(
		/- name: ☁️ Workers unit tests\n([\s\S]*?)\n\n\s+- name: ⏱️ Unit job budget/,
	)?.[1]
	expect(workersUnitStep).toBeTruthy()
	expect(workersUnitStep).not.toContain('--no-isolate')
	expect(workersUnitStep).not.toContain('--no-verify')
	expect(workersUnitStep).not.toContain('setupFiles')
	expect(workflow).toMatch(
		/name: ☁️ Workers\n\s+# Room for one ≤720s attempt[\s\S]*?timeout-minutes: 30/,
	)

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
		String(Math.floor(Date.now() / 1000) - 721),
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
