import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { runJobNowViaManager } from '#worker/jobs/manager-do.ts'
import {
	jobRunNowInputSchema,
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
		inputSchema: jobRunNowInputSchema,
		outputSchema: jobRunNowOutputSchema,
		async handler(args, ctx) {
			const user = requireJobsUser(ctx)
			return await runJobNowViaManager({
				env: ctx.env,
				userId: user.userId,
				jobId: args.id,
				callerContext: ctx.callerContext,
				repoCheckPolicyOverride: args.repoCheckPolicy,
			})
		},
	},
)
