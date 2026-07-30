import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	createScheduledJobFromArgs,
	jobScheduleOutputSchema,
	oneOffJobScheduleInputSchema,
} from './shared.ts'

export const jobScheduleOnceCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_schedule_once',
		description:
			'Schedule a one-off repo-backed job without creating a saved package. The job code runs later with execute semantics and gets its own durable storage bucket. Optional expires_at auto-disables the job after a UTC timestamp.',
		keywords: [
			'job',
			'schedule',
			'one-off',
			'once',
			'delayed',
			'background',
			'later',
			'expires',
			'expiry',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: oneOffJobScheduleInputSchema,
		outputSchema: jobScheduleOutputSchema,
		async handler(args, ctx) {
			return createScheduledJobFromArgs({
				env: ctx.env,
				callerContext: ctx.callerContext,
				args: {
					name: args.name,
					code: args.code,
					params: args.params,
					schedule: {
						type: 'once',
						run_at: args.run_at,
					},
					timezone: args.timezone,
					expires_at: args.expires_at,
				},
				defaultName: 'One-off job',
			})
		},
	},
)
