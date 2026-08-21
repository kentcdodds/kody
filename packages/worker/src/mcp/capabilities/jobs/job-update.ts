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
			'Update metadata on a scheduled job owned by the signed-in user: enabled, kill switch, preserved, expires_at, params, schedule, and timezone. Package-owned jobs keep source in the package repo, so name, code, and published source cannot change here — edit the package and publish. Jobs that are not package-owned accept the same metadata fields and cannot change source through this capability.',
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
			'expires',
			'expiry',
			'preserved',
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
