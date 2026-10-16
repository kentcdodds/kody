import { isRetryableD1LockError } from '@kody-internal/shared/d1-retry.ts'
import {
	logJobSchedulerEvent,
	schedulerErrorFields,
} from '@kody-internal/shared/jobs/scheduler-logging.ts'

/**
 * Backoff when JobManager alarm work hits a transient D1 platform lock/export
 * blip. Longer than the 1s backlog rearm so we do not hammer an in-progress
 * Cloudflare D1 REST/API export.
 */
export const jobD1UnavailableRearmDelayMs = 30_000

/**
 * When `error` is a retryable D1 lock/export blip, arm a short-backoff alarm
 * and return true so the Durable Object alarm handler can return without
 * rethrowing (preserving CF alarm retries and ensuring a follow-up wake).
 * Non-retryable errors return false; the caller should rethrow.
 */
export async function tryRearmAlarmForRetryableD1Failure(input: {
	setAlarm: (atMs: number) => Promise<void>
	userId: string
	error: unknown
	phase: 'run_due_jobs' | 'sync_alarm'
	retryCount?: number
	isRetry?: boolean
	nowMs?: number
}): Promise<boolean> {
	if (!isRetryableD1LockError(input.error)) {
		return false
	}
	const alarmAtMs = (input.nowMs ?? Date.now()) + jobD1UnavailableRearmDelayMs
	await input.setAlarm(alarmAtMs)
	logJobSchedulerEvent({
		event: 'alarm_deferred_d1_unavailable',
		userId: input.userId,
		reason: input.phase,
		retryCount: input.retryCount,
		isRetry: input.isRetry,
		nextRunAt: new Date(alarmAtMs).toISOString(),
		...schedulerErrorFields(input.error),
	})
	return true
}
