import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	jobScheduleInputSchema,
	jobScheduleOutputSchema,
	type JobScheduleCapabilityInput,
	createScheduledJobFromArgs,
} from './shared.ts'

export const jobScheduleCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_schedule',
		description:
			'Schedule a repo-backed job without creating a saved package first. Supports one-off, interval, and cron schedules, and each job gets its own durable storage bucket.',
		keywords: [
			'job',
			'schedule',
			'one-off',
			'interval',
			'cron',
			'recurring',
			'background',
			'delayed',
			'later',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: jobScheduleInputSchema,
		outputSchema: jobScheduleOutputSchema,
		async handler(args: JobScheduleCapabilityInput, ctx) {
			return createScheduledJobFromArgs({
				env: ctx.env,
				callerContext: ctx.callerContext,
				args,
			})
		},
	},
)
