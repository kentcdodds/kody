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
	api?: ApiOptions
}

export const DEFAULT_MAX_EXPORT_POLLS = 120
export const DEFAULT_EXPORT_POLL_INTERVAL_SECONDS = 15

const API_STEP_CONFIG: DurableStepConfig = {
	retries: { limit: 0, delay: '1 second' },
	timeout: '1 minute',
	sensitive: 'output',
}

export async function runDurableExport(
	env: BackupEnvironment,
	step: DurableExportStep,
	options: DurableExportOptions = {},
): Promise<ExportReady> {
	const maxPolls = options.maxPolls ?? DEFAULT_MAX_EXPORT_POLLS
	const interval =
		options.pollIntervalSeconds ?? DEFAULT_EXPORT_POLL_INTERVAL_SECONDS
	if (!Number.isInteger(maxPolls) || maxPolls <= 0) {
		throw new BackupError(
			'invalid-max-polls',
			'maximum D1 export polls must be a positive integer',
		)
	}
	if (!Number.isInteger(interval) || interval <= 0) {
		throw new BackupError(
			'invalid-poll-interval',
			'D1 export poll interval must be a positive integer',
		)
	}

	let state: ExportState = await step.do(
		'start-d1-export',
		API_STEP_CONFIG,
		async () => startD1Export(env, options.api),
	)
	for (let poll = 1; poll <= maxPolls; poll += 1) {
		if (state.kind === 'complete') return state
		await step.sleep(`wait-d1-export-${poll}`, `${interval} seconds`)
		const bookmark = state.bookmark
		state = await step.do(`poll-d1-export-${poll}`, API_STEP_CONFIG, async () =>
			pollD1Export(env, bookmark, options.api),
		)
	}
	switch (state.kind) {
		case 'complete':
			return state
		case 'pending':
			throw new BackupError(
				'export-poll-limit',
				'D1 export did not complete within the bounded polling window',
				false,
			)
		default: {
			const exhaustive: never = state
			throw exhaustive
		}
	}
}
