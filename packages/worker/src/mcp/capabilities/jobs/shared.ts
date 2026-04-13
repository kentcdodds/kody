import { z } from 'zod'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	type JobDetails,
	type JobRunHistoryEntry,
	type JobSchedule,
} from '#worker/jobs/types.ts'

export const jobScheduleSchema = z.union([
	z.object({
		cron: z
			.string()
			.min(1)
			.describe(
				'Standard 5-field cron expression: minute hour day-of-month month day-of-week.',
			),
	}),
	z.object({
		intervalMs: z
			.number()
			.int()
			.positive()
			.describe('Fixed run interval in milliseconds.'),
	}),
]) satisfies z.ZodType<JobSchedule>

export const jobErrorSchema = z.object({
	message: z.string(),
	stack: z.string().nullable(),
})

export const jobDetailsSchema = z.object({
	id: z.string(),
	userId: z.string(),
	name: z.string(),
	serverCode: z.string(),
	serverCodeId: z.string(),
	schedule: jobScheduleSchema,
	timezone: z.string(),
	enabled: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string(),
	nextRunAt: z.string().nullable(),
	runCount: z.number(),
	successCount: z.number(),
	failureCount: z.number(),
	lastRunStartedAt: z.string().nullable(),
	lastRunFinishedAt: z.string().nullable(),
	lastRunDurationMs: z.number().nullable(),
	lastError: jobErrorSchema.nullable(),
	killSwitchEnabled: z.boolean(),
	historyLimit: z.number(),
	scheduleSummary: z.string(),
}) satisfies z.ZodType<JobDetails>

export const jobHistoryEntrySchema = z.object({
	id: z.number(),
	trigger: z.enum(['alarm', 'run_now']),
	status: z.enum(['success', 'failure']),
	scheduledFor: z.string().nullable(),
	startedAt: z.string(),
	finishedAt: z.string(),
	durationMs: z.number(),
	error: jobErrorSchema.nullable(),
}) satisfies z.ZodType<JobRunHistoryEntry>

export const jobExecutionSchema = z.union([
	z.object({
		ok: z.literal(true),
		result: z.unknown(),
	}),
	z.object({
		ok: z.literal(false),
		error: jobErrorSchema,
	}),
	z.object({
		ok: z.literal(false),
		skipped: z.literal(true),
	}),
])

export const jobCreateInputSchema = z.object({
	name: z.string().min(1),
	serverCode: z
		.string()
		.min(1)
		.describe(
			'Durable Object source that must export `class Job extends DurableObject` with an async `run()` method.',
		),
	schedule: jobScheduleSchema,
	timezone: z
		.string()
		.nullable()
		.optional()
		.describe('Optional IANA timezone. Defaults to America/Denver.'),
	enabled: z.boolean().optional(),
})

export const jobUpdatePatchSchema = z.object({
	name: z.string().min(1).optional(),
	serverCode: z.string().min(1).optional(),
	schedule: jobScheduleSchema.optional(),
	timezone: z.string().nullable().optional(),
	enabled: z.boolean().optional(),
	kill_switch_enabled: z.boolean().optional(),
	history_limit: z.number().int().min(1).max(500).optional(),
})

export const jobIdInputSchema = z.object({
	job_id: z.string().min(1),
})

export const jobHistoryInputSchema = z.object({
	job_id: z.string().min(1),
	limit: z.number().int().min(1).max(500).optional(),
})

export const jobUpdateInputSchema = z.object({
	job_id: z.string().min(1),
	patch: jobUpdatePatchSchema,
})

export const jobServerExecInputSchema = z.object({
	job_id: z.string().min(1),
	code: z
		.string()
		.min(1)
		.describe(
			'JavaScript snippet compiled into a throwaway Dynamic Worker. The snippet runs with `job` (RPC stub to the job facet) and `params` in scope.',
		),
	params: z.record(z.string(), z.unknown()).optional(),
})

export const jobCapabilityKeywords = [
	'job',
	'schedule',
	'cron',
	'interval',
	'durable object',
] as const

export function requireJobsUser(ctx: CapabilityContext) {
	return requireMcpUser(ctx.callerContext)
}
