import { z } from 'zod'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { type JobManagerDebugState } from '#worker/jobs/manager-client.ts'
import { logJobSchedulerEvent } from '#worker/jobs/scheduler-logging.ts'
import {
	type JobCreateInput,
	type JobExecutionResult,
	type JobSchedule,
	type JobView,
} from '#worker/jobs/types.ts'

const onceScheduleSchema = z.object({
	type: z.literal('once'),
	run_at: z
		.string()
		.min(1)
		.describe(
			'UTC timestamp for the one-off run, for example 2026-04-20T18:30:00Z.',
		),
})

const intervalScheduleSchema = z.object({
	type: z.literal('interval'),
	every: z
		.string()
		.min(1)
		.describe(
			'Recurring interval such as 15m, 1h, or 1d using ms, s, m, h, or d units.',
		),
})

const cronScheduleSchema = z.object({
	type: z.literal('cron'),
	expression: z
		.string()
		.min(1)
		.describe(
			'Standard 5-field cron expression: minute hour day-of-month month day-of-week.',
		),
})

export const scheduledJobInputBaseSchema = {
	name: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional human-readable job name. Defaults to "Scheduled job" when omitted.',
		),
	code: z
		.string()
		.min(1)
		.describe(
			'ES module source for the job entrypoint. It must default export the function Kody should run later.',
		),
	params: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			'Optional JSON params passed to the job entrypoint when it runs.',
		),
	timezone: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional timezone label for cron display and schedule calculation. Defaults to UTC when omitted.',
		),
}

export const scheduledJobScheduleSchema = z.discriminatedUnion('type', [
	onceScheduleSchema,
	intervalScheduleSchema,
	cronScheduleSchema,
])

export const scheduledJobSummarySchema = z.discriminatedUnion('type', [
	onceScheduleSchema,
	intervalScheduleSchema,
	cronScheduleSchema,
])

export const jobInspectionInputSchema = z.object({
	id: z
		.string()
		.min(1)
		.describe('Job id from job_list output or a previous scheduling response.'),
})

const nonNegativeIntegerSchema = z.number().int().min(0)

const jobRunHistoryEntrySchema = z.object({
	started_at: z.string(),
	finished_at: z.string(),
	status: z.enum(['success', 'error']),
	duration_ms: nonNegativeIntegerSchema,
	error: z.string().nullable(),
})

const runHistoryEntrySchema = z.object({
	started_at: z.string(),
	finished_at: z.string(),
	status: z.enum(['success', 'error']),
	duration_ms: nonNegativeIntegerSchema,
	error: z.string().optional(),
})

export const jobInspectionSchema = z.object({
	id: z.string(),
	name: z.string(),
	source_id: z.string(),
	published_commit: z.string().nullable(),
	storage_id: z.string(),
	schedule: scheduledJobSummarySchema,
	schedule_summary: z.string(),
	timezone: z.string(),
	enabled: z.boolean(),
	kill_switch_enabled: z.boolean(),
	created_at: z.string(),
	updated_at: z.string(),
	next_run_at: z.string(),
	due_now: z.boolean(),
	last_run_at: z.string().nullable(),
	last_run_status: z.enum(['success', 'error']).nullable(),
	last_run_error: z.string().nullable(),
	last_duration_ms: nonNegativeIntegerSchema.nullable(),
	run_count: nonNegativeIntegerSchema,
	success_count: nonNegativeIntegerSchema,
	error_count: nonNegativeIntegerSchema,
	recent_runs: z.array(jobRunHistoryEntrySchema),
})

export const jobManagerDebugSchema = z.object({
	binding_available: z.boolean(),
	status: z.enum(['missing_binding', 'idle', 'armed', 'out_of_sync']),
	stored_user_id: z.string().nullable(),
	alarm_scheduled_for: z.string().nullable(),
	next_runnable_job_id: z.string().nullable(),
	next_runnable_run_at: z.string().nullable(),
	alarm_in_sync: z.boolean().nullable(),
})

export const jobListOutputSchema = z.object({
	jobs: z.array(jobInspectionSchema),
	alarm: jobManagerDebugSchema,
})

export const jobGetOutputSchema = z.object({
	job: jobInspectionSchema,
	alarm: jobManagerDebugSchema,
})

export const jobScheduleInputSchema = z.object({
	...scheduledJobInputBaseSchema,
	schedule: scheduledJobScheduleSchema,
})

export const oneOffJobScheduleInputSchema = z.object({
	...scheduledJobInputBaseSchema,
	run_at: z
		.string()
		.min(1)
		.describe(
			'UTC timestamp for the one-off run, for example 2026-04-20T18:30:00Z.',
		),
})

export const jobScheduleOutputSchema = z.object({
	job_id: z.string(),
	name: z.string(),
	source_id: z.string(),
	storage_id: z.string(),
	schedule: scheduledJobSummarySchema,
	schedule_summary: z.string(),
	created_at: z.string(),
	next_run_at: z.string(),
})

export const jobViewOutputSchema = z.object({
	job_id: z.string(),
	name: z.string(),
	source_id: z.string(),
	published_commit: z.string().nullable(),
	storage_id: z.string(),
	params: z.record(z.string(), z.unknown()).optional(),
	schedule: scheduledJobSummarySchema,
	schedule_summary: z.string(),
	timezone: z.string(),
	enabled: z.boolean(),
	kill_switch_enabled: z.boolean(),
	created_at: z.string(),
	updated_at: z.string(),
	last_run_at: z.string().optional(),
	last_run_status: z.enum(['success', 'error']).optional(),
	last_run_error: z.string().optional(),
	last_duration_ms: nonNegativeIntegerSchema.optional(),
	next_run_at: z.string(),
	run_count: nonNegativeIntegerSchema,
	success_count: nonNegativeIntegerSchema,
	error_count: nonNegativeIntegerSchema,
	run_history: z.array(runHistoryEntrySchema),
})

export const jobExecutionOutputSchema = z.discriminatedUnion('ok', [
	z.object({
		ok: z.literal(true),
		result: z.unknown().optional(),
		logs: z.array(z.string()),
	}),
	z.object({
		ok: z.literal(false),
		error: z.string(),
		logs: z.array(z.string()),
	}),
])

export const jobRunNowInputSchema = z.object({
	id: z.string().min(1).describe('Existing job id to execute immediately.'),
})

export const jobRunNowOutputSchema = z.object({
	job: jobViewOutputSchema,
	execution: jobExecutionOutputSchema,
	deleted_after_run: z
		.boolean()
		.describe(
			'Whether the job was deleted after this run, which happens for one-off schedules.',
		),
})

export type JobScheduleCapabilityInput = z.infer<typeof jobScheduleInputSchema>
export type JobRunNowCapabilityInput = z.infer<typeof jobRunNowInputSchema>

export function buildJobScheduleSummaryOutput(schedule: JobView['schedule']) {
	switch (schedule.type) {
		case 'once':
			return {
				type: 'once' as const,
				run_at: schedule.runAt,
			}
		case 'interval':
			return {
				type: 'interval' as const,
				every: schedule.every,
			}
		case 'cron':
			return {
				type: 'cron' as const,
				expression: schedule.expression,
			}
	}
}

export function toJobSchedule(
	schedule: z.infer<typeof scheduledJobScheduleSchema>,
): JobSchedule {
	switch (schedule.type) {
		case 'once':
			return {
				type: 'once',
				runAt: schedule.run_at,
			}
		case 'interval':
			return {
				type: 'interval',
				every: schedule.every,
			}
		case 'cron':
			return {
				type: 'cron',
				expression: schedule.expression,
			}
	}
}

export function resolveJobCreateBody(
	input: JobScheduleCapabilityInput,
	defaultName = 'Scheduled job',
): JobCreateInput {
	return {
		name: input.name?.trim() || defaultName,
		code: input.code,
		params: input.params,
		schedule: toJobSchedule(input.schedule),
		timezone: input.timezone ?? null,
	}
}

export function buildJobScheduleOutput(created: JobView) {
	return {
		job_id: created.id,
		name: created.name,
		source_id: created.sourceId,
		storage_id: created.storageId,
		schedule: buildJobScheduleSummaryOutput(created.schedule),
		schedule_summary: created.scheduleSummary,
		created_at: created.createdAt,
		next_run_at: created.nextRunAt,
	}
}

export function buildJobViewOutput(job: JobView) {
	return {
		job_id: job.id,
		name: job.name,
		source_id: job.sourceId,
		published_commit: job.publishedCommit,
		storage_id: job.storageId,
		params: job.params,
		schedule: buildJobScheduleSummaryOutput(job.schedule),
		schedule_summary: job.scheduleSummary,
		timezone: job.timezone,
		enabled: job.enabled,
		kill_switch_enabled: job.killSwitchEnabled,
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		last_run_at: job.lastRunAt,
		last_run_status: job.lastRunStatus,
		last_run_error: job.lastRunError,
		last_duration_ms: job.lastDurationMs,
		next_run_at: job.nextRunAt,
		run_count: job.runCount,
		success_count: job.successCount,
		error_count: job.errorCount,
		run_history: job.runHistory.map((entry) => ({
			started_at: entry.startedAt,
			finished_at: entry.finishedAt,
			status: entry.status,
			duration_ms: entry.durationMs,
			error: entry.error,
		})),
	}
}

export function buildJobInspectionOutput(
	job: JobView,
	input: { now?: Date } = {},
) {
	const now = input.now ?? new Date()
	const nextRunAtValue = new Date(job.nextRunAt).valueOf()
	const dueNow =
		job.enabled &&
		job.killSwitchEnabled === false &&
		Number.isFinite(nextRunAtValue) &&
		nextRunAtValue <= now.valueOf()

	return {
		id: job.id,
		name: job.name,
		source_id: job.sourceId,
		published_commit: job.publishedCommit,
		storage_id: job.storageId,
		schedule: buildJobScheduleSummaryOutput(job.schedule),
		schedule_summary: job.scheduleSummary,
		timezone: job.timezone,
		enabled: job.enabled,
		kill_switch_enabled: job.killSwitchEnabled,
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		next_run_at: job.nextRunAt,
		due_now: dueNow,
		last_run_at: job.lastRunAt ?? null,
		last_run_status: job.lastRunStatus ?? null,
		last_run_error: job.lastRunError ?? null,
		last_duration_ms: job.lastDurationMs ?? null,
		run_count: job.runCount,
		success_count: job.successCount,
		error_count: job.errorCount,
		recent_runs: job.runHistory.map((entry) => ({
			started_at: entry.startedAt,
			finished_at: entry.finishedAt,
			status: entry.status,
			duration_ms: entry.durationMs,
			error: entry.error ?? null,
		})),
	}
}

export function buildJobManagerDebugOutput(state: JobManagerDebugState) {
	return {
		binding_available: state.bindingAvailable,
		status: state.status,
		stored_user_id: state.storedUserId,
		alarm_scheduled_for: state.alarmScheduledFor,
		next_runnable_job_id: state.nextRunnableJobId,
		next_runnable_run_at: state.nextRunnableRunAt,
		alarm_in_sync: state.alarmInSync,
	}
}

export function buildJobRunNowOutput(input: {
	job: JobView
	execution: JobExecutionResult
	deletedAfterRun: boolean
}) {
	return {
		job: buildJobViewOutput(input.job),
		execution: input.execution,
		deleted_after_run: input.deletedAfterRun,
	}
}

export async function createScheduledJobFromArgs(input: {
	env: Env
	callerContext: CapabilityContext['callerContext']
	args: JobScheduleCapabilityInput
	defaultName?: string
}) {
	const user = requireMcpUser(input.callerContext)
	// Delay job runtime imports so capability registration can load without
	// recursively pulling the full jobs runtime back through the registry.
	const { createJob } = await import('#worker/jobs/service.ts')
	const created = await createJob({
		env: input.env,
		callerContext: input.callerContext,
		body: resolveJobCreateBody(input.args, input.defaultName),
	})
	logJobSchedulerEvent({
		event: 'job_created',
		userId: user.userId,
		jobId: created.id,
		scheduleType: created.schedule.type,
		nextRunAt: created.nextRunAt,
	})
	return buildJobScheduleOutput(created)
}

export async function runJobNowFromArgs(input: {
	env: Env
	callerContext: CapabilityContext['callerContext']
	args: JobRunNowCapabilityInput
}) {
	const user = requireMcpUser(input.callerContext)
	const { runJobNowViaManager } = await import('#worker/jobs/manager-client.ts')
	const result = await runJobNowViaManager({
		env: input.env,
		userId: user.userId,
		jobId: input.args.id,
		callerContext: input.callerContext,
	})
	return buildJobRunNowOutput(result)
}
