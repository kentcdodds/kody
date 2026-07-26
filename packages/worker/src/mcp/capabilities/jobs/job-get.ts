import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listRunRecords } from '#worker/run-records/service.ts'
import {
	buildJobInspectionOutput,
	buildJobManagerDebugOutput,
	buildJobSourceInspectionOutput,
	formatJobRecentRunFromRecord,
	jobGetInputSchema,
	jobGetOutputSchema,
	resolveJobGetId,
} from './shared.ts'

export const jobGetCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_get',
		description:
			'Load one scheduled job for the signed-in user, including debugging fields such as run counters, last error, recent run history from run records (with run ids for run_get log drill-down), current alarm state, and optionally the published source code.',
		keywords: [
			'job',
			'inspect',
			'debug',
			'status',
			'scheduled job',
			'source code',
			'recent runs',
			'logs',
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
			const recentPage = await listRunRecords({
				env: ctx.env,
				userId: user.userId,
				filter: { jobId, surface: 'job' },
				limit: 10,
			})
			const recentRuns = recentPage.runs.flatMap((run) => {
				const formatted = formatJobRecentRunFromRecord(run)
				return formatted ? [formatted] : []
			})
			return {
				job: buildJobInspectionOutput(inspection.job, { recentRuns }),
				alarm: buildJobManagerDebugOutput(inspection.alarm),
				...(inspection.source
					? { source: buildJobSourceInspectionOutput(inspection.source) }
					: {}),
			}
		},
	},
)
