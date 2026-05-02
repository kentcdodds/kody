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
			'Delete an existing scheduled job owned by the signed-in user by id. Use this to remove a mistaken or obsolete schedule entirely.',
		keywords: [
			'job',
			'delete',
			'remove',
			'cancel',
			'unschedule',
			'cleanup',
		],
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
