import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	type JobRunNowCapabilityInput,
	jobRunNowInputSchema,
	jobRunNowOutputSchema,
	runJobNowFromArgs,
} from './shared.ts'

export const jobRunNowCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_run_now',
		description:
			'Run an existing repo-backed job immediately by id using the normal job runtime, then return the updated job state and execution result for debugging.',
		keywords: [
			'job',
			'run',
			'run now',
			'immediate',
			'manual',
			'execute',
			'debug',
			'backfill',
			'trigger',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: jobRunNowInputSchema,
		outputSchema: jobRunNowOutputSchema,
		async handler(args: JobRunNowCapabilityInput, ctx) {
			return runJobNowFromArgs({
				env: ctx.env,
				callerContext: ctx.callerContext,
				args,
			})
		},
	},
)
