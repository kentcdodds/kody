import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { listJobs } from '#worker/jobs/service.ts'
import {
	jobCapabilityKeywords,
	jobViewSchema,
	requireJobsUser,
} from './shared.ts'

export const jobListCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_list',
		description:
			'List jobs for the signed-in user with schedule details, observability counters, last error, and next run time.',
		keywords: [...jobCapabilityKeywords, 'list'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.array(jobViewSchema),
		async handler(_args, ctx) {
			const user = requireJobsUser(ctx)
			return listJobs({
				env: ctx.env,
				userId: user.userId,
			})
		},
	},
)
