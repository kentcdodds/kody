/**
 * Fail a Validate unit leg when a warm (Nx cache hit) run exceeds the
 * unit-test budget (Node ≤60s, Workers ≤90s). Measured from a start epoch
 * recorded at the beginning of the same job. A cold Nx cache miss must not
 * fail the budget.
 *
 * Usage:
 *   node tools/ci/enforce-unit-job-budget.ts --leg node --start-epoch 1710000000 \
 *     --nx-log unit-job-nx.log
 *   node tools/ci/enforce-unit-job-budget.ts --leg workers --start-epoch 1710000000 \
 *     --nx-log unit-job-nx.log
 */
import { readFileSync } from 'node:fs'
import { isExecutedDirectly } from '../node-runtime.ts'

export const unitJobBudgets = {
	node: {
		leg: 'node',
		jobName: '🧪 Node',
		maxSeconds: 60,
	},
	workers: {
		leg: 'workers',
		jobName: '☁️ Workers',
		maxSeconds: 90,
	},
} as const

export type UnitJobLeg = keyof typeof unitJobBudgets

export type NxCacheStatus = 'hit' | 'miss' | 'unknown'

export type UnitJobBudgetResult = {
	ok: boolean
	leg: UnitJobLeg
	jobName: string
	elapsedSeconds: number
	maxSeconds: number
	nxCacheStatus: NxCacheStatus
	summary: string
}

/** Nx prints `Cache: 1/1 hit (100%)` (or 0/1) after the task summary. */
export const nxCacheHitSummaryPattern =
	/Cache:\s*(?<hits>\d+)\s*\/\s*(?<total>\d+)\s+hit/i

export function isUnitJobLeg(value: string): value is UnitJobLeg {
	return value === 'node' || value === 'workers'
}

export function parseNxCacheStatus(logText: string): NxCacheStatus {
	const matches = [
		...logText.matchAll(new RegExp(nxCacheHitSummaryPattern.source, 'gi')),
	]
	if (matches.length === 0) return 'unknown'
	const last = matches[matches.length - 1]
	const hits = Number(last?.groups?.hits)
	const total = Number(last?.groups?.total)
	if (!Number.isFinite(hits) || !Number.isFinite(total) || total <= 0) {
		return 'unknown'
	}
	return hits >= total ? 'hit' : 'miss'
}

export function evaluateUnitJobBudget(input: {
	leg: UnitJobLeg
	startEpochSeconds: number
	nowEpochSeconds?: number
	nxCacheStatus?: NxCacheStatus
}): UnitJobBudgetResult {
	const budget = unitJobBudgets[input.leg]
	const nxCacheStatus = input.nxCacheStatus ?? 'unknown'
	const now =
		typeof input.nowEpochSeconds === 'number'
			? input.nowEpochSeconds
			: Math.floor(Date.now() / 1000)
	const elapsedSeconds = Math.max(0, now - input.startEpochSeconds)

	if (nxCacheStatus !== 'hit') {
		const reason =
			nxCacheStatus === 'miss'
				? 'Nx cache miss'
				: 'Nx cache status unknown (treated as miss)'
		return {
			ok: true,
			leg: input.leg,
			jobName: budget.jobName,
			elapsedSeconds,
			maxSeconds: budget.maxSeconds,
			nxCacheStatus,
			summary: `${budget.jobName} finished in ${elapsedSeconds}s; skipping the ${budget.maxSeconds}s budget because of ${reason}. Warm (cache-hit) overruns still fail.`,
		}
	}

	const ok = elapsedSeconds <= budget.maxSeconds
	const summary = ok
		? `${budget.jobName} finished in ${elapsedSeconds}s on an Nx cache hit (budget ${budget.maxSeconds}s).`
		: `${budget.jobName} took ${elapsedSeconds}s on an Nx cache hit; budget is ${budget.maxSeconds}s. Speed up the suite - do not delete or skip tests to game the budget.`
	return {
		ok,
		leg: input.leg,
		jobName: budget.jobName,
		elapsedSeconds,
		maxSeconds: budget.maxSeconds,
		nxCacheStatus,
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
	const nxLogPath = readFlag(args, '--nx-log')
	if (!legRaw || !isUnitJobLeg(legRaw) || !startRaw || !nxLogPath) {
		console.error(
			'Usage: node tools/ci/enforce-unit-job-budget.ts --leg <node|workers> --start-epoch <unix-seconds> --nx-log <path>',
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

	let nxLogText = ''
	try {
		nxLogText = readFileSync(nxLogPath, 'utf8')
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		console.error(`Could not read --nx-log ${nxLogPath}: ${detail}`)
		process.exitCode = 1
		return
	}

	const result = evaluateUnitJobBudget({
		leg: legRaw,
		startEpochSeconds,
		nxCacheStatus: parseNxCacheStatus(nxLogText),
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
