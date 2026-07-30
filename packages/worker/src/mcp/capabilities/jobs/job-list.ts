import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { inspectJobsForUser } from '#worker/jobs/inspect.ts'
import {
	buildJobInspectionOutput,
	buildJobManagerDebugOutput,
	jobListOutputSchema,
} from './shared.ts'

export const jobListCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_list',
		description:
			"List scheduled jobs for the signed-in user with status, counters, and job-manager alarm state for debugging scheduling issues. recent_runs is empty here for efficiency; use job_get for one job's recent runs or run_list/run_summary for cross-job failure history.",
		keywords: [
			'job',
			'list',
			'inspect',
			'debug',
			'scheduled jobs',
			'alarm',
			'status',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: jobListOutputSchema,
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const inspection = await inspectJobsForUser({
				env: ctx.env,
				userId: user.userId,
			})
			return {
				jobs: inspection.jobs.map((job) =>
					buildJobInspectionOutput(job, { recentRuns: [] }),
				),
				alarm: buildJobManagerDebugOutput(inspection.alarm),
			}
		},
	},
)
