import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

const inputSchema = z.object({
	name: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional human-readable job name. Defaults to "One-off job" when omitted.',
		),
	code: z
		.string()
		.min(1)
		.describe(
			'ES module source for the job entrypoint. It must default export the function Kody should run later.',
		),
	run_at: z
		.string()
		.min(1)
		.describe('Timestamp for the one-off run, for example 2026-04-20T18:30:00Z.'),
	params: z
		.record(z.string(), z.unknown())
		.optional()
		.describe('Optional JSON params passed to the job entrypoint when it runs.'),
	timezone: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional timezone label for schedule display. Defaults to UTC when omitted.',
		),
})

const outputSchema = z.object({
	job_id: z.string(),
	name: z.string(),
	source_id: z.string(),
	storage_id: z.string(),
	run_at: z.string(),
	schedule_summary: z.string(),
	created_at: z.string(),
	next_run_at: z.string(),
})

export const jobScheduleOnceCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_schedule_once',
		description:
			'Schedule a one-off repo-backed job without creating a saved package. The job code runs later with execute semantics and gets its own durable storage bucket.',
		keywords: [
			'job',
			'schedule',
			'one-off',
			'once',
			'delayed',
			'background',
			'later',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const { createJob } = await import('#worker/jobs/service.ts')
			const { syncJobManagerAlarm } = await import(
				'#worker/jobs/manager-client.ts'
			)
			const created = await createJob({
				env: ctx.env,
				callerContext: ctx.callerContext,
				body: {
					name: args.name?.trim() || 'One-off job',
					code: args.code,
					params: args.params,
					schedule: {
						type: 'once',
						runAt: args.run_at,
					},
					timezone: args.timezone ?? null,
				},
			})
			await syncJobManagerAlarm({
				env: ctx.env,
				userId: user.userId,
			})
			return {
				job_id: created.id,
				name: created.name,
				source_id: created.sourceId,
				storage_id: created.storageId,
				run_at: created.schedule.type === 'once' ? created.schedule.runAt : '',
				schedule_summary: created.scheduleSummary,
				created_at: created.createdAt,
				next_run_at: created.nextRunAt,
			}
		},
	},
)
