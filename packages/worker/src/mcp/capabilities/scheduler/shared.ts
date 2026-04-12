import { z } from 'zod'
import {
	type ScheduledJobView,
	type SchedulerCreateInput,
	type SchedulerExecutionResult,
	type SchedulerUpdateInput,
} from '#worker/scheduler/types.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const schedulerScheduleSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('cron'),
		expression: z
			.string()
			.min(1)
			.describe(
				'Standard 5-field cron expression: minute hour day-of-month month day-of-week.',
			),
	}),
	z.object({
		type: z.literal('once'),
		runAt: z
			.string()
			.min(1)
			.describe('ISO 8601 UTC timestamp for a one-shot run.'),
	}),
])

export const schedulerJobViewSchema = z.object({
	id: z.string(),
	name: z.string(),
	code: z.string(),
	params: z.record(z.string(), z.unknown()).optional(),
	schedule: schedulerScheduleSchema,
	timezone: z.string(),
	enabled: z.boolean(),
	createdAt: z.string(),
	lastRunAt: z.string().optional(),
	lastRunStatus: z.enum(['success', 'error']).optional(),
	lastRunError: z.string().optional(),
	nextRunAt: z.string(),
	scheduleSummary: z.string(),
}) satisfies z.ZodType<ScheduledJobView>

export const schedulerCapabilityKeywords = [
	'schedule',
	'scheduler',
	'cron',
	'datetime',
	'job',
] as const

export const scheduledJobIdInputSchema = z.object({
	id: z.string().min(1).describe('Identifier of the scheduled job.'),
})

export const schedulerCreateInputSchema = z.object({
	name: z.string().min(1).describe('Human-friendly job name.'),
	code: z
		.string()
		.min(1)
		.describe('Codemode async arrow function source to execute on schedule.'),
	params: z
		.record(z.string(), z.unknown())
		.optional()
		.describe('Optional params injected into the scheduled codemode execution.'),
	schedule: schedulerScheduleSchema,
	timezone: z
		.string()
		.optional()
		.describe(
			'Optional IANA timezone used when interpreting cron expressions. Defaults to UTC.',
		),
	enabled: z
		.boolean()
		.optional()
		.describe('Whether the new job should be enabled immediately. Defaults to true.'),
}) satisfies z.ZodType<SchedulerCreateInput>

export const schedulerUpdateInputSchema = z.object({
	id: z.string().min(1).describe('Existing scheduled job id.'),
	name: z.string().min(1).optional().describe('Optional new job name.'),
	code: z
		.string()
		.min(1)
		.optional()
		.describe('Optional replacement codemode source.'),
	params: z
		.record(z.string(), z.unknown())
		.nullable()
		.optional()
		.describe(
			'Optional replacement params. Pass null to clear previously stored params.',
		),
	schedule: schedulerScheduleSchema.optional(),
	timezone: z
		.string()
		.nullable()
		.optional()
		.describe('Optional replacement IANA timezone. Pass null to reset to UTC.'),
	enabled: z
		.boolean()
		.optional()
		.describe('Optional replacement enabled flag.'),
}) satisfies z.ZodType<SchedulerUpdateInput>

export const schedulerExecutionResultSchema = z.discriminatedUnion('ok', [
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
]) satisfies z.ZodType<SchedulerExecutionResult>

export const schedulerRunNowOutputSchema = z.object({
	job: schedulerJobViewSchema,
	execution: schedulerExecutionResultSchema,
})

export const schedulerDeleteOutputSchema = z.object({
	id: z.string(),
	deleted: z.literal(true),
})

export function requireSchedulerUser(ctx: CapabilityContext) {
	return requireMcpUser(ctx.callerContext)
}
