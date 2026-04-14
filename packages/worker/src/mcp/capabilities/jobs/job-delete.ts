import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-do.ts'
import { deleteJob } from '#worker/jobs/service.ts'
import {
	jobDeleteOutputSchema,
	jobIdInputSchema,
	requireJobsUser,
} from './shared.ts'

export const jobDeleteCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_delete',
		description: 'Delete a stored job.',
		keywords: ['job', 'delete', 'remove'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: jobIdInputSchema,
		outputSchema: jobDeleteOutputSchema,
		async handler(args, ctx) {
			const user = requireJobsUser(ctx)
			const result = await deleteJob({
				env: ctx.env,
				userId: user.userId,
				jobId: args.id,
			})
			await syncJobManagerAlarm({
				env: ctx.env,
				userId: user.userId,
			})
			return result
		},
	},
)
