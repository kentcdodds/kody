import { z } from 'zod'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
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
		.describe('Optional JSON params passed to the job entrypoint when it runs.'),
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

const scheduledJobSummarySchema = z.discriminatedUnion('type', [
	onceScheduleSchema,
	intervalScheduleSchema,
	cronScheduleSchema,
])

const runHistoryEntrySchema = z.object({
	started_at: z.string(),
	finished_at: z.string(),
	status: z.enum(['success', 'error']),
	duration_ms: z.number(),
	error: z.string().optional(),
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
	last_duration_ms: z.number().optional(),
	next_run_at: z.string(),
	run_count: z.number(),
	success_count: z.number(),
	error_count: z.number(),
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
		schedule: (() => {
			switch (created.schedule.type) {
				case 'once':
					return {
						type: 'once' as const,
						run_at: created.schedule.runAt,
					}
				case 'interval':
					return {
						type: 'interval' as const,
						every: created.schedule.every,
					}
				case 'cron':
					return {
						type: 'cron' as const,
						expression: created.schedule.expression,
					}
			}
		})(),
		schedule_summary: created.scheduleSummary,
		created_at: created.createdAt,
		next_run_at: created.nextRunAt,
	}
}

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

export function buildJobRunNowOutput(input: {
	job: JobView
	execution: JobExecutionResult
}) {
	return {
		job: buildJobViewOutput(input.job),
		execution: input.execution,
		deleted_after_run: input.job.schedule.type === 'once',
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
	const { syncJobManagerAlarm } = await import('#worker/jobs/manager-client.ts')
	const created = await createJob({
		env: input.env,
		callerContext: input.callerContext,
		body: resolveJobCreateBody(input.args, input.defaultName),
	})
	await syncJobManagerAlarm({
		env: input.env,
		userId: user.userId,
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
