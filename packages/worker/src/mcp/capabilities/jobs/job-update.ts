import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	type JobUpdateCapabilityInput,
	jobUpdateInputSchema,
	jobViewOutputSchema,
	updateJobFromArgs,
} from './shared.ts'

export const jobUpdateCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_update',
		description:
			'Update a scheduled job owned by the signed-in user. Supports safe mutable fields such as name, code, params, schedule, timezone, enabled state, and kill-switch state.',
		keywords: [
			'job',
			'update',
			'edit',
			'reschedule',
			'rename',
			'enable',
			'disable',
			'kill switch',
			'timezone',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: jobUpdateInputSchema,
		outputSchema: jobViewOutputSchema,
		async handler(args: JobUpdateCapabilityInput, ctx) {
			return updateJobFromArgs({
				env: ctx.env,
				callerContext: ctx.callerContext,
				args,
			})
		},
	},
)
