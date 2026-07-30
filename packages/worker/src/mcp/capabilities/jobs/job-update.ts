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
			"Update a scheduled job owned by the signed-in user. Supports safe mutable fields such as name, code, params, schedule, timezone, enabled state, kill-switch state, preserved, and expires_at (null clears). When `code` is provided Kody publishes a new commit on the job's repo-backed source and replaces the job's existing published module. Use this to change job source for non-package jobs without opening a repo session. The replacement code must default export the job entrypoint (e.g. `export default async function main(input = {}) { ... }`) and read `params` from its first argument; there is no `params` export from `kody:runtime`.",
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
