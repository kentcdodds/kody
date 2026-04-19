import { z } from 'zod'
import {
	type JobExecutionResult,
	type JobRepoCheckPolicy,
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

export const jobViewSchema = z.object({
	version: z.literal(1),
	id: z.string(),
	name: z.string(),
	sourceId: z.string(),
	publishedCommit: z.string().nullable(),
	repoCheckPolicy: z
		.object({
			allowTypecheckFailures: z.boolean().optional(),
		})
		.optional(),
	storageId: z.string(),
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

export const jobRepoCheckPolicySchema = z
	.object({
		allowTypecheckFailures: z
			.boolean()
			.optional()
			.describe(
				'For repo-backed jobs only, allow execution to continue when Worker-native checks fail only in the typecheck category. Missing manifest, entrypoint, dependency, lint, and smoke checks still block execution.',
			),
	})
	.strict() satisfies z.ZodType<JobRepoCheckPolicy>

export const jobUpsertInputSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Existing job id to update in place. Omit to create a new job.',
			),
		name: z
			.string()
			.min(1)
			.optional()
			.describe('Job name. Required when creating a new job.'),
		code: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Default-exported module source for the job entrypoint. Kody publishes this source into the repo-backed job snapshot.',
			),
		sourceId: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Shared source id for the repo-backed job implementation. Omit on create to let Kody create the backing source automatically.',
			),
		publishedCommit: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'Published commit pinned for repo-backed job execution. Optional on create; updated automatically when the repo session publish flow promotes changes.',
			),
		repoCheckPolicy: jobRepoCheckPolicySchema
			.nullable()
			.optional()
			.describe(
				'Optional repo-backed execution policy. This is opt-in and does not change publish-time repo checks.',
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
			.describe(
				'Emergency stop that blocks execution without deleting the job.',
			),
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
		if (value.schedule === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['schedule'],
				message: 'schedule is required when creating a job.',
			})
		}
		if (value.code === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['code'],
				message: 'code is required when creating a job.',
			})
		}
	}) satisfies z.ZodType<JobUpsertInput>

export const jobRunNowInputSchema = z.object({
	id: z.string().min(1).describe('Identifier of the job.'),
	repoCheckPolicy: jobRepoCheckPolicySchema
		.nullable()
		.optional()
		.describe(
			'Optional one-off repo-backed execution policy override for this immediate run only.',
		),
})

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
