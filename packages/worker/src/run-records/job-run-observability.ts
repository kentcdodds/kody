/**
 * Per-job last-run outcome and counters stored in the RunLog Durable Object.
 *
 * Mirrors the observability columns on D1 `jobs` (`last_run_*`,
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
	/**
	 * Set once after a successful D1 legacy seed (including successful empty).
	 * Post-cutover finishes may create the row first; a later seed then merges
	 * legacy counters exactly once while this flag is still unset.
	 */
	legacySeeded: boolean
}

export type JobRunObservabilityUpsertInput = {
	jobId: string
	status: JobRunObservabilityStatus
	ranAt: string
	error?: string | null
	durationMs?: number | null
}

/**
 * Legacy D1 `jobs` observability snapshot. Applied exactly once per job
 * (`legacy_seeded`): absent rows insert; rows created by post-cutover finishes
 * add counters and keep the newer last-run outcome by timestamp.
 */
export type JobRunObservabilitySeedInput = Omit<
	JobRunObservabilityRecord,
	'legacySeeded'
>

/**
 * Hard cap for one {@link seedJobRunObservabilityBatch} RPC. Oversized batches
 * fail closed rather than silently slicing.
 */
export const jobRunObservabilitySeedMaxBatch = 500

/**
 * Batch seed counters. `attempted` is the input array length (including blank
 * `jobId` entries). Blank ids are neither `seeded` nor `alreadySeeded`, so
 * `attempted` may exceed `seeded + alreadySeeded`.
 */
export type JobRunObservabilityBatchSeedResult = {
	attempted: number
	seeded: number
	alreadySeeded: number
}

/** Outcome of one once-only job-observability seed attempt. */
export type JobRunObservabilitySeedApplyStatus =
	| 'seeded'
	| 'already-seeded'
	| 'blank'
