import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-do.ts'
import { runJobNow } from '#worker/jobs/service.ts'
import {
	jobIdInputSchema,
	jobRunNowOutputSchema,
	requireJobsUser,
} from './shared.ts'

export const jobRunNowCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_run_now',
		description:
			'Trigger a stored job immediately without changing its normal schedule.',
		keywords: ['job', 'run now', 'trigger'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: jobIdInputSchema,
		outputSchema: jobRunNowOutputSchema,
		async handler(args, ctx) {
			const user = requireJobsUser(ctx)
			try {
				return await runJobNow({
					env: ctx.env,
					userId: user.userId,
					jobId: args.id,
					callerContext: ctx.callerContext,
				})
			} finally {
				await syncJobManagerAlarm({
					env: ctx.env,
					userId: user.userId,
				})
			}
		},
	},
)
