/**
 * Fail a Validate unit leg when wall-clock exceeds the cold-run baseline
 * budget (Node ≤360s, Workers ≤720s). Measured from a start epoch recorded at
 * the beginning of the same job. Cache hit or miss does not change the cap.
 *
 * Usage:
 *   node tools/ci/enforce-unit-job-budget.ts --leg node --start-epoch 1710000000
 *   node tools/ci/enforce-unit-job-budget.ts --leg workers --start-epoch 1710000000
 */
import { isExecutedDirectly } from '../node-runtime.ts'

const unitJobBudgets = {
	node: {
		leg: 'node',
		jobName: '🧪 Node',
		maxSeconds: 360,
	},
	workers: {
		leg: 'workers',
		jobName: '☁️ Workers',
		maxSeconds: 720,
	},
} as const

export type UnitJobLeg = keyof typeof unitJobBudgets

export type UnitJobBudgetResult = {
	ok: boolean
	leg: UnitJobLeg
	jobName: string
	elapsedSeconds: number
	maxSeconds: number
	summary: string
}

export function isUnitJobLeg(value: string): value is UnitJobLeg {
	return value === 'node' || value === 'workers'
}

export function evaluateUnitJobBudget(input: {
	leg: UnitJobLeg
	startEpochSeconds: number
	nowEpochSeconds?: number
}): UnitJobBudgetResult {
	const budget = unitJobBudgets[input.leg]
	const now =
		typeof input.nowEpochSeconds === 'number'
			? input.nowEpochSeconds
			: Math.floor(Date.now() / 1000)
	const elapsedSeconds = Math.max(0, now - input.startEpochSeconds)
	const ok = elapsedSeconds <= budget.maxSeconds
	const summary = ok
		? `${budget.jobName} finished in ${elapsedSeconds}s (budget ${budget.maxSeconds}s).`
		: `${budget.jobName} took ${elapsedSeconds}s; budget is ${budget.maxSeconds}s. Speed up the suite - do not delete or skip tests to game the budget.`
	return {
		ok,
		leg: input.leg,
		jobName: budget.jobName,
		elapsedSeconds,
		maxSeconds: budget.maxSeconds,
		summary,
	}
}

function readFlag(args: Array<string>, name: string) {
	const index = args.indexOf(name)
	if (index === -1) return null
	const value = args[index + 1]
	if (!value || value.startsWith('--')) return null
	return value
}

export function main(args = process.argv.slice(2)) {
	const legRaw = readFlag(args, '--leg')
	const startRaw = readFlag(args, '--start-epoch')
	if (!legRaw || !isUnitJobLeg(legRaw) || !startRaw) {
		console.error(
			'Usage: node tools/ci/enforce-unit-job-budget.ts --leg <node|workers> --start-epoch <unix-seconds>',
		)
		process.exitCode = 1
		return
	}
	const startEpochSeconds = Number(startRaw)
	if (!Number.isFinite(startEpochSeconds)) {
		console.error(`Invalid --start-epoch: ${startRaw}`)
		process.exitCode = 1
		return
	}

	const result = evaluateUnitJobBudget({
		leg: legRaw,
		startEpochSeconds,
	})
	if (result.ok) {
		console.log(result.summary)
		process.exitCode = 0
		return
	}
	console.error(result.summary)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
