import { z } from 'zod'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { type JobCreateInput, type JobSchedule, type JobView } from '#worker/jobs/types.ts'

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

export type JobScheduleCapabilityInput = z.infer<typeof jobScheduleInputSchema>

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
