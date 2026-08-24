import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	deleteJobFromArgs,
	type JobDeleteCapabilityInput,
	jobDeleteInputSchema,
	jobDeleteOutputSchema,
} from './shared.ts'

export const jobDeleteCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_delete',
		description:
			'Delete a leftover scheduled job by id. Package-owned jobs cannot be deleted this way — remove the job from the package and publish. Recurring schedules belong on a package (`kody.jobs`); deferred one-shots use `workflows.create`.',
		keywords: ['job', 'delete', 'remove', 'cancel', 'unschedule', 'cleanup'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: jobDeleteInputSchema,
		outputSchema: jobDeleteOutputSchema,
		async handler(args: JobDeleteCapabilityInput, ctx) {
			return deleteJobFromArgs({
				env: ctx.env,
				callerContext: ctx.callerContext,
				args,
			})
		},
	},
)
