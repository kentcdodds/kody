import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { runAppJob } from '#worker/apps/service.ts'

const outputSchema = z.object({
	job: z.object({
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
		schedule: z.discriminatedUnion('type', [
			z.object({
				type: z.literal('cron'),
				expression: z.string(),
			}),
			z.object({
				type: z.literal('interval'),
				every: z.string(),
			}),
			z.object({
				type: z.literal('once'),
				runAt: z.string(),
			}),
		]),
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
	}),
	execution: z.discriminatedUnion('ok', [
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
	]),
})

export const appRunJobCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'app_run_job',
		description:
			'Trigger a saved app job immediately without changing its normal schedule.',
		keywords: ['app', 'job', 'run now', 'trigger', 'schedule'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z
			.object({
				app_id: z.string().min(1),
				job_id: z.string().min(1).optional(),
				job_name: z.string().min(1).optional(),
			})
			.superRefine((value, ctx) => {
				const refs = Number(Boolean(value.job_id)) + Number(Boolean(value.job_name))
				if (refs !== 1) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ['job_id'],
						message: 'Provide exactly one of job_id or job_name.',
					})
				}
			}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return runAppJob({
				env: ctx.env,
				callerContext: ctx.callerContext,
				appId: args.app_id,
				jobId: args.job_id,
				jobName: args.job_name,
			})
		},
	},
)
