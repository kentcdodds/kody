import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { getJob } from '#worker/jobs/service.ts'
import { jobIdInputSchema, jobViewSchema, requireJobsUser } from './shared.ts'

export const jobGetCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_get',
		description: 'Inspect one job by id.',
		keywords: ['job', 'get', 'inspect'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: jobIdInputSchema,
		outputSchema: jobViewSchema,
		async handler(args, ctx) {
			const user = requireJobsUser(ctx)
			return getJob({
				env: ctx.env,
				userId: user.userId,
				jobId: args.id,
			})
		},
	},
)
