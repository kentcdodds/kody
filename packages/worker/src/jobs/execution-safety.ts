import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'
import { isDurableObjectIsolateResetMessage } from '#worker/sentry-options.ts'
import {
	type RunRecord,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import {
	type JobExecutionOutcome,
	type PersistedJobCallerContext,
} from './types.ts'

export const jobRetryBaseDelayMs = 5_000
export const jobRetryMaximumDelayMs = 5 * 60 * 1_000

export class TransientJobExecutionError extends Error {
	override readonly name = 'TransientJobExecutionError'
}

export function buildScheduledJobIdempotencyKey(input: {
	jobId: string
	scheduledFor: string
}) {
	return `scheduled-job:${input.jobId}:${input.scheduledFor}`
}

export function isTransientJobExecutionError(error: unknown) {
	return (
		error instanceof TransientJobExecutionError ||
		isRetryableD1LockError(error) ||
		errorCauseChainIncludes(error, isDurableObjectIsolateResetMessage)
	)
}

export function markPreExecutionTransientError(error: unknown): unknown {
	if (
		error instanceof TransientJobExecutionError ||
		!isTransientJobExecutionError(error)
	) {
		return error
	}
	const message = error instanceof Error ? error.message : String(error)
	return new TransientJobExecutionError(message, { cause: error })
}

export function computeJobRetryAt(input: { now: Date; retryCount: number }) {
	const delayMs = Math.min(
		jobRetryMaximumDelayMs,
		jobRetryBaseDelayMs * 2 ** Math.max(0, input.retryCount),
	)
	return new Date(input.now.valueOf() + delayMs).toISOString()
}

export function replayScheduledJobRun(run: RunRecord): JobExecutionOutcome {
	const finishedAt = run.finishedAt ?? run.startedAt
	switch (run.status) {
		case 'success':
			return {
				execution: {
					ok: true,
					result: run.metadata['result'],
					logs: [],
				},
				startedAt: run.startedAt,
				finishedAt,
				durationMs: run.durationMs ?? 0,
			}
		case 'error':
			return {
				execution: {
					ok: false,
					error:
						run.errorMessage ??
						'The retained scheduled job run ended with an unknown error.',
					logs: [],
				},
				startedAt: run.startedAt,
				finishedAt,
				durationMs: run.durationMs ?? 0,
			}
		case 'running':
			throw new TransientJobExecutionError(
				'A previous execution still owns this scheduled occurrence; it will be retried without duplicate execution.',
			)
		default: {
			const exhaustive: never = run.status
			throw new Error(`Unhandled run status: ${String(exhaustive)}`)
		}
	}
}

export async function executeOrReplayScheduledJobRun(input: {
	claim:
		| { claimed: true; handle: RunRecordHandle }
		| { claimed: false; run: RunRecord }
		| null
	execute: (handle: RunRecordHandle) => Promise<JobExecutionOutcome>
}) {
	if (!input.claim) {
		throw new TransientJobExecutionError(
			'Unable to claim scheduled job idempotency key; RUN_LOG is unavailable.',
		)
	}
	if (!input.claim.claimed) {
		return replayScheduledJobRun(input.claim.run)
	}
	return await input.execute(input.claim.handle)
}

export function resolveScheduledJobCallerContext(input: {
	rowUserId: string
	callerContext: PersistedJobCallerContext | null
}) {
	return input.callerContext?.user.userId === input.rowUserId
		? input.callerContext
		: null
}
