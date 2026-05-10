import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	buildJobInspectionOutput,
	buildJobManagerDebugOutput,
	buildJobSourceInspectionOutput,
	jobGetInputSchema,
	jobGetOutputSchema,
} from './shared.ts'

function resolveJobGetId(input: { id?: string; job_id?: string }) {
	if (input.id && input.job_id && input.id !== input.job_id) {
		throw new Error('id and job_id must match when both are provided.')
	}
	const jobId = input.id ?? input.job_id
	if (!jobId) {
		throw new Error('Job id is required.')
	}
	return jobId
}

export const jobGetCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_get',
		description:
			'Load one scheduled job for the signed-in user, including debugging fields such as run counters, last error, recent run history, current alarm state, and optionally the published source code.',
		keywords: [
			'job',
			'inspect',
			'debug',
			'status',
			'scheduled job',
			'source code',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: jobGetInputSchema,
		outputSchema: jobGetOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const { getJobInspection } = await import('#worker/jobs/service.ts')
			const jobId = resolveJobGetId(args)
			const inspection = await getJobInspection({
				env: ctx.env,
				userId: user.userId,
				jobId,
				includeCode: args.includeCode ?? false,
			})
			return {
				job: buildJobInspectionOutput(inspection.job),
				alarm: buildJobManagerDebugOutput(inspection.alarm),
				...(inspection.source
					? { source: buildJobSourceInspectionOutput(inspection.source) }
					: {}),
			}
		},
	},
)
