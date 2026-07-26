import { z } from 'zod'
import {
	type RunRecord,
	type RunRecordLog,
	type RunRecordSummary,
	type RunRecordSurfaceSummary,
	runLogLevelValues,
	runRecordDefaultPageSize,
	runRecordMaxPageSize,
	runStatusValues,
	runSurfaceValues,
} from '#worker/run-records/types.ts'

export const runSurfaceSchema = z.enum(runSurfaceValues)

export const runStatusSchema = z.enum(runStatusValues)

export const runRecordSchema = z.object({
	id: z.string(),
	surface: runSurfaceSchema,
	status: runStatusSchema,
	name: z.string().nullable(),
	package_id: z.string().nullable(),
	kody_id: z.string().nullable(),
	source_id: z.string().nullable(),
	published_commit: z.string().nullable(),
	storage_id: z.string().nullable(),
	job_id: z.string().nullable(),
	workflow_id: z.string().nullable(),
	invocation_id: z.string().nullable(),
	session_id: z.string().nullable(),
	idempotency_key: z.string().nullable(),
	parent_run_id: z.string().nullable(),
	started_at: z.string(),
	finished_at: z.string().nullable(),
	duration_ms: z.number().int().nonnegative().nullable(),
	error_name: z.string().nullable(),
	error_message: z.string().nullable(),
	metadata: z.record(z.string(), z.unknown()),
	log_count: z.number().int().nonnegative(),
})

export const runRecordLogSchema = z.object({
	run_id: z.string(),
	sequence: z.number().int().nonnegative(),
	level: z.enum(runLogLevelValues),
	message: z.string(),
	fields: z.record(z.string(), z.unknown()).nullable(),
})

export const runRecordSurfaceSummarySchema = z.object({
	surface: runSurfaceSchema,
	total: z.number().int().nonnegative(),
	errors: z.number().int().nonnegative(),
})

export const runRecordSummarySchema = z.object({
	since: z.string(),
	total: z.number().int().nonnegative(),
	errors: z.number().int().nonnegative(),
	running: z.number().int().nonnegative(),
	by_surface: z.array(runRecordSurfaceSummarySchema),
})

export const runListLimitSchema = z
	.number()
	.int()
	.positive()
	.max(runRecordMaxPageSize)
	.optional()
	.describe(
		`Page size (default ${runRecordDefaultPageSize}, max ${runRecordMaxPageSize}).`,
	)

export function formatRunRecord(
	run: RunRecord,
): z.infer<typeof runRecordSchema> {
	return {
		id: run.id,
		surface: run.surface,
		status: run.status,
		name: run.name,
		package_id: run.packageId,
		kody_id: run.kodyId,
		source_id: run.sourceId,
		published_commit: run.publishedCommit,
		storage_id: run.storageId,
		job_id: run.jobId,
		workflow_id: run.workflowId,
		invocation_id: run.invocationId,
		session_id: run.sessionId,
		idempotency_key: run.idempotencyKey,
		parent_run_id: run.parentRunId,
		started_at: run.startedAt,
		finished_at: run.finishedAt,
		duration_ms: run.durationMs,
		error_name: run.errorName,
		error_message: run.errorMessage,
		metadata: run.metadata,
		log_count: run.logCount,
	}
}

export function formatRunRecordLog(
	log: RunRecordLog,
): z.infer<typeof runRecordLogSchema> {
	return {
		run_id: log.runId,
		sequence: log.sequence,
		level: log.level,
		message: log.message,
		fields: log.fields,
	}
}

export function formatRunRecordSurfaceSummary(
	summary: RunRecordSurfaceSummary,
): z.infer<typeof runRecordSurfaceSummarySchema> {
	return {
		surface: summary.surface,
		total: summary.total,
		errors: summary.errors,
	}
}

export function formatRunRecordSummary(
	summary: RunRecordSummary,
): z.infer<typeof runRecordSummarySchema> {
	return {
		since: summary.since,
		total: summary.total,
		errors: summary.errors,
		running: summary.running,
		by_surface: summary.bySurface.map(formatRunRecordSurfaceSummary),
	}
}
