import {
	pollD1Export,
	startD1Export,
	type ApiOptions,
} from './d1-export-api.ts'
import { BackupError } from './backup-policy.ts'
import {
	type BackupEnvironment,
	type ExportReady,
	type ExportState,
} from './backup-types.ts'

interface DurableStepConfig {
	retries: {
		limit: number
		delay: '1 second'
	}
	timeout: '1 minute'
	sensitive: 'output'
}

export interface DurableExportStep {
	do<T>(
		name: string,
		config: DurableStepConfig,
		callback: () => Promise<T>,
	): Promise<T>
	sleep(name: string, duration: `${number} seconds`): Promise<void>
}

export interface DurableExportOptions {
	maxPolls?: number
	pollIntervalSeconds?: number
	earlyPollCount?: number
	earlyPollIntervalSeconds?: number
	maxExportRestarts?: number
	api?: ApiOptions
}

export const DEFAULT_MAX_EXPORT_POLLS = 120
export const DEFAULT_EXPORT_POLL_INTERVAL_SECONDS = 15
export const DEFAULT_EARLY_POLL_COUNT = 5
export const DEFAULT_EARLY_POLL_INTERVAL_SECONDS = 2
export const DEFAULT_MAX_EXPORT_RESTARTS = 3

const API_STEP_CONFIG: DurableStepConfig = {
	retries: { limit: 0, delay: '1 second' },
	timeout: '1 minute',
	sensitive: 'output',
}

function waitDuration(
	pollIndex: number,
	earlyCount: number,
	earlyInterval: number,
	laterInterval: number,
): `${number} seconds` {
	const seconds = pollIndex <= earlyCount ? earlyInterval : laterInterval
	return `${seconds} seconds`
}

export async function runDurableExport(
	env: BackupEnvironment,
	step: DurableExportStep,
	options: DurableExportOptions = {},
): Promise<ExportReady> {
	const maxPolls = options.maxPolls ?? DEFAULT_MAX_EXPORT_POLLS
	const laterInterval =
		options.pollIntervalSeconds ?? DEFAULT_EXPORT_POLL_INTERVAL_SECONDS
	const earlyCount = options.earlyPollCount ?? DEFAULT_EARLY_POLL_COUNT
	const earlyInterval =
		options.earlyPollIntervalSeconds ?? DEFAULT_EARLY_POLL_INTERVAL_SECONDS
	const maxRestarts = options.maxExportRestarts ?? DEFAULT_MAX_EXPORT_RESTARTS
	if (!Number.isInteger(maxPolls) || maxPolls <= 0) {
		throw new BackupError(
			'invalid-max-polls',
			'maximum D1 export polls must be a positive integer',
		)
	}
	if (!Number.isInteger(laterInterval) || laterInterval <= 0) {
		throw new BackupError(
			'invalid-poll-interval',
			'D1 export poll interval must be a positive integer',
		)
	}
	if (!Number.isInteger(earlyInterval) || earlyInterval <= 0) {
		throw new BackupError(
			'invalid-poll-interval',
			'D1 export early poll interval must be a positive integer',
		)
	}
	if (!Number.isInteger(earlyCount) || earlyCount < 0) {
		throw new BackupError(
			'invalid-early-poll-count',
			'D1 export early poll count must be a non-negative integer',
		)
	}
	if (!Number.isInteger(maxRestarts) || maxRestarts < 0) {
		throw new BackupError(
			'invalid-export-restart-limit',
			'D1 export restart limit must be a non-negative integer',
		)
	}

	let state: ExportState = await step.do(
		'start-d1-export',
		API_STEP_CONFIG,
		async () => startD1Export(env, options.api),
	)
	let restarts = 0
	let polls = 0

	while (true) {
		switch (state.kind) {
			case 'complete':
				return state
			case 'lost': {
				if (restarts >= maxRestarts) {
					throw new BackupError(
						'export-restart-limit',
						'D1 export result expired too many times',
					)
				}
				restarts += 1
				state = await step.do(
					`restart-d1-export-${restarts}`,
					API_STEP_CONFIG,
					async () => startD1Export(env, options.api),
				)
				continue
			}
			case 'pending': {
				if (polls >= maxPolls) {
					throw new BackupError(
						'export-poll-limit',
						'D1 export did not complete within the bounded polling window',
						false,
					)
				}
				polls += 1
				const bookmark = state.bookmark
				// Poll immediately after start/restart and after each wait.
				state = await step.do(
					`poll-d1-export-${polls}`,
					API_STEP_CONFIG,
					async () => pollD1Export(env, bookmark, options.api),
				)
				if (state.kind === 'complete') return state
				if (state.kind === 'lost') continue
				if (polls < maxPolls) {
					await step.sleep(
						`wait-d1-export-${polls}`,
						waitDuration(polls, earlyCount, earlyInterval, laterInterval),
					)
				}
				continue
			}
			default: {
				const exhaustive: never = state
				throw exhaustive
			}
		}
	}
}
