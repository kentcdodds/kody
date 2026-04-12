import { z } from 'zod'
import {
	type ScheduledJobView,
	type SchedulerExecutionResult,
	type SchedulerUpsertInput,
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

export const schedulerUpsertInputSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Existing scheduled job id to update in place. Omit to create a new scheduled job.',
			),
		name: z
			.string()
			.min(1)
			.optional()
			.describe('Job name. Required when creating a new scheduled job.'),
		code: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Codemode async arrow function source. Required when creating a new scheduled job.',
			),
		params: z
			.record(z.string(), z.unknown())
			.nullable()
			.optional()
			.describe(
				'Optional params injected into the scheduled codemode execution. Pass null to clear previously stored params during an update.',
			),
		schedule: schedulerScheduleSchema
			.optional()
			.describe(
				'Schedule definition. Required when creating a new scheduled job.',
			),
		timezone: z
			.string()
			.nullable()
			.optional()
			.describe(
				'Optional IANA timezone used when interpreting cron expressions. Pass null to reset to UTC during an update.',
			),
		enabled: z
			.boolean()
			.optional()
			.describe(
				'Whether the job should be enabled. Defaults to true when creating a new scheduled job.',
			),
	})
	.superRefine((value, ctx) => {
		if (value.id !== undefined) return
		if (value.name === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['name'],
				message: 'name is required when creating a scheduled job.',
			})
		}
		if (value.code === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['code'],
				message: 'code is required when creating a scheduled job.',
			})
		}
		if (value.schedule === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['schedule'],
				message: 'schedule is required when creating a scheduled job.',
			})
		}
	}) satisfies z.ZodType<SchedulerUpsertInput>

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
