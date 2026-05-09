import { z } from 'zod'
import {
	type PackageRuntimeLogRecord,
	type PackageRuntimeRunRecord,
	packageRuntimeLogLevelValues,
	packageRuntimeStatusValues,
	packageRuntimeSurfaceValues,
} from '#worker/package-runtime/package-runtime-debug.ts'

export const packageRuntimeSurfaceSchema = z.enum(packageRuntimeSurfaceValues)

export const packageRuntimeRunSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	package_id: z.string(),
	kody_id: z.string(),
	source_id: z.string().nullable(),
	published_commit: z.string().nullable(),
	surface: packageRuntimeSurfaceSchema,
	name: z.string().nullable(),
	status: z.enum(packageRuntimeStatusValues),
	started_at: z.string(),
	finished_at: z.string().nullable(),
	duration_ms: z.number().int().nonnegative().nullable(),
	error_name: z.string().nullable(),
	error_message: z.string().nullable(),
	storage_id: z.string().nullable(),
	job_id: z.string().nullable(),
	workflow_id: z.string().nullable(),
	invocation_id: z.string().nullable(),
	session_id: z.string().nullable(),
	idempotency_key: z.string().nullable(),
	parent_run_id: z.string().nullable(),
	metadata: z.record(z.string(), z.unknown()),
	created_at: z.string(),
	updated_at: z.string(),
})

export const packageRuntimeLogSchema = z.object({
	id: z.string(),
	run_id: z.string(),
	user_id: z.string(),
	package_id: z.string(),
	timestamp: z.string(),
	sequence: z.number().int().nonnegative(),
	level: z.enum(packageRuntimeLogLevelValues),
	message: z.string(),
	fields: z.record(z.string(), z.unknown()).nullable(),
	created_at: z.string(),
})

export function formatPackageRuntimeRun(
	run: PackageRuntimeRunRecord,
): z.infer<typeof packageRuntimeRunSchema> {
	return {
		id: run.id,
		user_id: run.userId,
		package_id: run.packageId,
		kody_id: run.kodyId,
		source_id: run.sourceId,
		published_commit: run.publishedCommit,
		surface: run.surface,
		name: run.name,
		status: run.status,
		started_at: run.startedAt,
		finished_at: run.finishedAt,
		duration_ms: run.durationMs,
		error_name: run.errorName,
		error_message: run.errorMessage,
		storage_id: run.storageId,
		job_id: run.jobId,
		workflow_id: run.workflowId,
		invocation_id: run.invocationId,
		session_id: run.sessionId,
		idempotency_key: run.idempotencyKey,
		parent_run_id: run.parentRunId,
		metadata: run.metadata,
		created_at: run.createdAt,
		updated_at: run.updatedAt,
	}
}

export function formatPackageRuntimeLog(
	log: PackageRuntimeLogRecord,
): z.infer<typeof packageRuntimeLogSchema> {
	return {
		id: log.id,
		run_id: log.runId,
		user_id: log.userId,
		package_id: log.packageId,
		timestamp: log.timestamp,
		sequence: log.sequence,
		level: log.level,
		message: log.message,
		fields: log.fields,
		created_at: log.createdAt,
	}
}
