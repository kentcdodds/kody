import { z } from 'zod'
import {
	type JobExecutionResult,
	type JobUpsertInput,
	type JobView,
} from '#worker/jobs/types.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const jobScheduleSchema = z.discriminatedUnion('type', [
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
		type: z.literal('interval'),
		every: z
			.string()
			.min(1)
			.describe('Interval duration such as "15m", "1h", or "1d".'),
	}),
	z.object({
		type: z.literal('once'),
		runAt: z
			.string()
			.min(1)
			.describe('ISO 8601 UTC timestamp for a one-shot run.'),
	}),
])

export const jobKindSchema = z.enum(['codemode', 'facet'])

export const jobViewSchema = z.object({
	version: z.literal(1),
	id: z.string(),
	name: z.string(),
	kind: jobKindSchema,
	code: z.string().optional(),
	serverCode: z.string().optional(),
	serverCodeId: z.string().optional(),
	methodName: z.string().optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	schedule: jobScheduleSchema,
	timezone: z.string(),
	enabled: z.boolean(),
	killSwitchEnabled: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string(),
	lastRunAt: z.string().optional(),
	lastRunStatus: z.enum(['success', 'error']).optional(),
	lastRunError: z.string().optional(),
	lastDurationMs: z.number().optional(),
	nextRunAt: z.string(),
	runCount: z.number(),
	successCount: z.number(),
	errorCount: z.number(),
	runHistory: z.array(
		z.object({
			startedAt: z.string(),
			finishedAt: z.string(),
			status: z.enum(['success', 'error']),
			durationMs: z.number(),
			error: z.string().optional(),
		}),
	),
	scheduleSummary: z.string(),
}) satisfies z.ZodType<JobView>

export const jobCapabilityKeywords = [
	'job',
	'jobs',
	'schedule',
	'cron',
	'interval',
	'datetime',
] as const

export const jobIdInputSchema = z.object({
	id: z.string().min(1).describe('Identifier of the job.'),
})

export const jobUpsertInputSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.optional()
			.describe('Existing job id to update in place. Omit to create a new job.'),
		name: z
			.string()
			.min(1)
			.optional()
			.describe('Job name. Required when creating a new job.'),
		kind: jobKindSchema
			.optional()
			.describe('Execution kind: "codemode" or "facet". Required on create.'),
		code: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe('Codemode async arrow function source. Use only for codemode jobs.'),
		serverCode: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'Facet job server code that exports `class Job extends DurableObject`. Use only for facet jobs.',
			),
		methodName: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'Facet job method invoked on each run. Defaults to `run` for facet jobs.',
			),
		params: z
			.record(z.string(), z.unknown())
			.nullable()
			.optional()
			.describe('Optional params passed to the stored job execution.'),
		schedule: jobScheduleSchema
			.optional()
			.describe('Schedule definition. Required when creating a new job.'),
		timezone: z
			.string()
			.nullable()
			.optional()
			.describe(
				'Optional IANA timezone used when interpreting cron schedules. Pass null to reset to UTC.',
			),
		enabled: z.boolean().optional().describe('Whether the job should run.'),
		killSwitchEnabled: z
			.boolean()
			.optional()
			.describe('Emergency stop that blocks execution without deleting the job.'),
	})
	.superRefine((value, ctx) => {
		if (value.id !== undefined) return
		if (value.name === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['name'],
				message: 'name is required when creating a job.',
			})
		}
		if (value.kind === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['kind'],
				message: 'kind is required when creating a job.',
			})
		}
		if (value.schedule === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['schedule'],
				message: 'schedule is required when creating a job.',
			})
		}
		if (value.kind === 'codemode' && value.code === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['code'],
				message: 'code is required when creating a codemode job.',
			})
		}
		if (value.kind === 'facet' && value.serverCode === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['serverCode'],
				message: 'serverCode is required when creating a facet job.',
			})
		}
	}) satisfies z.ZodType<JobUpsertInput>

export const jobExecutionResultSchema = z.discriminatedUnion('ok', [
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
]) satisfies z.ZodType<JobExecutionResult>

export const jobRunNowOutputSchema = z.object({
	job: jobViewSchema,
	execution: jobExecutionResultSchema,
})

export const jobDeleteOutputSchema = z.object({
	id: z.string(),
	deleted: z.literal(true),
})

export function requireJobsUser(ctx: CapabilityContext) {
	return requireMcpUser(ctx.callerContext)
}
