import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { getJobInspection } from '#worker/jobs/service.ts'
import {
	buildJobInspectionOutput,
	buildJobManagerDebugOutput,
	jobGetOutputSchema,
	jobInspectionInputSchema,
} from './shared.ts'

export const jobGetCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_get',
		description:
			'Load one scheduled job for the signed-in user, including debugging fields such as run counters, last error, recent run history, and current alarm state.',
		keywords: ['job', 'inspect', 'debug', 'status', 'scheduled job'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: jobInspectionInputSchema,
		outputSchema: jobGetOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const inspection = await getJobInspection({
				env: ctx.env,
				userId: user.userId,
				jobId: args.id,
			})
			return {
				job: buildJobInspectionOutput(inspection.job),
				alarm: buildJobManagerDebugOutput(inspection.alarm),
			}
		},
	},
)
