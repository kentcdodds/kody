/**
 * Per-job last-run outcome and counters stored in the RunLog Durable Object.
 *
 * Mirrors the observability columns formerly on D1 `jobs` (`last_run_*`,
 * `last_duration_ms`, `run_count` / `success_count` / `error_count`) without
 * coupling them to pruned run-history rows. One row per job id; the DO
 * identity is the user scope.
 */

export type JobRunObservabilityStatus = 'success' | 'error'

export type JobRunObservabilityRecord = {
	jobId: string
	lastRunAt: string | null
	lastRunStatus: JobRunObservabilityStatus | null
	lastRunError: string | null
	lastDurationMs: number | null
	runCount: number
	successCount: number
	errorCount: number
	updatedAt: string
}

export type JobRunObservabilityUpsertInput = {
	jobId: string
	status: JobRunObservabilityStatus
	ranAt: string
	error?: string | null
	durationMs?: number | null
}
